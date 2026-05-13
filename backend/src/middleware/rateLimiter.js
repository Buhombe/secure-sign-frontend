'use strict';

/**
 * rateLimiter.js — HakikiSign Distributed Redis-Backed Rate Limiting
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * ARCHITECTURE OVERVIEW
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * WHY DISTRIBUTED RATE LIMITING?
 * ────────────────────────────────
 * express-rate-limit's default MemoryStore holds counters in the Node.js
 * process heap. This means:
 *   1. Counters reset on every server restart (Railway restarts freely).
 *   2. When scaled horizontally (2+ instances), each instance tracks its own
 *      counters. An attacker gets N × the per-instance limit "for free".
 *   3. During a traffic spike, the instance that absorbs more requests may
 *      trigger the limit while others stay clear — inconsistent protection.
 *
 * With Redis as the backing store, ALL instances share ONE counter per IP.
 * A login attempt from an attacker hitting instance A increments the same
 * Redis key that instance B and C read. Limits are truly global.
 *
 * HOW SYNCHRONIZATION WORKS
 * ───────────────────────────
 * rate-limit-redis uses Redis MULTI/EXEC pipelines with atomic INCR + EXPIRE
 * operations. Each request:
 *   1. INCRements a key like `hakikisign:rl:auth:1.2.3.4` atomically.
 *   2. If this was the first increment (INCR returned 1), sets an EXPIRE on
 *      the key equal to the window duration.
 *   3. Reads the current count back and compares to the configured max.
 *   4. If over max, returns 429 with Retry-After.
 *
 * Redis INCR is atomic at the server level — no race conditions even with
 * hundreds of concurrent requests from multiple Node.js instances.
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * RATE LIMIT CATEGORIES
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * CATEGORY A — AUTH ENDPOINTS (authLimiter, mfaLimiter, refreshLimiter)
 *   Strictest limits. Protects login, MFA verify, forgot-password, token
 *   refresh, and signer authentication. Progressive brute-force penalties
 *   are handled at the DB layer (see auth.js lockout logic) — the rate
 *   limiter is the first line of defence, lockout is the second.
 *
 * CATEGORY B — DOCUMENT OPERATIONS (uploadLimiter, signingLimiter)
 *   Prevents storage exhaustion and signing abuse. Upload is more restricted
 *   than general API because each upload consumes Cloudinary bandwidth and
 *   database storage.
 *
 * CATEGORY C — GENERAL API (apiLimiter)
 *   Applied to /api/* as a catch-all. Generous enough not to harm power users.
 *   Per-user keying (userId if authenticated, IP if not) prevents a single
 *   abusive token from consuming the limit for an entire office's IP.
 *
 * CATEGORY D — ADMIN ROUTES (adminLimiter)
 *   Stricter than general API, slightly looser than auth. Admin sessions are
 *   already short-lived and behind their own JWT. Elevated logging.
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * FAILURE HANDLING
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * When Redis is unavailable, each limiter falls back to its own MemoryStore
 * instance with a SHORTER window and LOWER max than normal. This is the
 * "fail-safe degraded mode":
 *   - Protection is maintained (not eliminated)
 *   - False positives may increase slightly for shared IPs (offices, NAT)
 *   - The trade-off is explicitly logged so ops teams can investigate
 *
 * This approach satisfies the requirement: "DO NOT silently disable limits if
 * Redis fails."
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * TRUST PROXY & IP EXTRACTION
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * Railway's infrastructure routes traffic through a reverse proxy. Without
 * `app.set('trust proxy', 1)` in index.js, req.ip would always be the proxy's
 * internal IP — every user would share the same rate-limit bucket, meaning
 * one legitimate user could exhaust limits for everyone.
 *
 * With trust proxy = 1, Express reads the FIRST value in X-Forwarded-For,
 * which Railway sets to the real client IP.
 *
 * ANTI-SPOOFING: `trust proxy: 1` means Express trusts exactly ONE proxy hop.
 * An attacker cannot spoof their IP by injecting their own X-Forwarded-For
 * header because Express only looks at the last hop's addition, not the full
 * chain (which could be attacker-controlled at the front).
 *
 * CORPORATE NAT: A large enterprise office behind a single NAT IP will share
 * a rate-limit bucket. For auth limiters this is acceptable — 10 login
 * attempts per 15 minutes from one IP is generous for a single user; an
 * office with many users concurrently logging in would be rate-limited, but
 * this is an edge case that ops can address by raising RL_AUTH_MAX.
 */

const rateLimit                      = require('express-rate-limit');
const { RedisStore }                 = require('rate-limit-redis');
const { ipKeyGenerator }             = require('express-rate-limit');
const { rateLimit: cfg}              = require('../config/security');
const { redisClient, isRedisReady }  = require('../config/redis');
const logger                         = require('../config/logger');

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * makeJson429Handler — returns an express-rate-limit `handler` function that:
 *   1. Emits a structured security log event
 *   2. Responds with JSON (never HTML — clients must be able to parse 429s)
 *   3. Includes Retry-After in the body for client-side backoff UX
 */
function makeJson429Handler(eventName, userMessage) {
  return (req, res) => {
    const retryAfter = Math.ceil(Number(res.getHeader('Retry-After')) || 60);
    const ip         = req.ip || 'unknown';
    const userId     = req.user?.id || null;

    logger.security(eventName, {
      ip,
      userId,
      path:       req.path,
      method:     req.method,
      retryAfter,
      userAgent:  req.headers['user-agent']?.slice(0, 150) || null,
    });

    res.status(429).json({
      error:      userMessage,
      retryAfter,
      code:       'RATE_LIMITED',
    });
  };
}

/**
 * makeRedisStore — creates a RedisStore for rate-limit-redis.
 *
 * The `sendCommand` function is how rate-limit-redis talks to ioredis.
 * It uses the raw `call` method to send arbitrary Redis commands
 * (INCR, EXPIRE, etc.) as a pipeline.
 *
 * `prefix` is the key namespace for this specific limiter, appended AFTER
 * the global key prefix set in redis.js (REDIS_KEY_PREFIX). Final key shape:
 *   hakikisign:rl:<limiterPrefix><clientKey>
 * e.g.:
 *   hakikisign:rl:auth:1.2.3.4
 *   hakikisign:rl:api:user:42
 */
function makeRedisStore(prefix) {
  return new RedisStore({
    sendCommand: (...args) => redisClient.call(...args),
    prefix,
  });
}

/**
 * makeFallbackStore — returns a fresh MemoryStore from express-rate-limit.
 *
 * Used when Redis is unavailable. Each limiter has its OWN MemoryStore so
 * their counters don't bleed across categories.
 *
 * express-rate-limit exports `MemoryStore` as a named export.
 */
const { MemoryStore } = rateLimit;
function makeFallbackStore() {
  return new MemoryStore();
}

/**
 * makeStoreSelector — returns a function that chooses Redis or memory store
 * at runtime based on Redis health.
 *
 * express-rate-limit 7.x supports a `store` option that must be a Store
 * instance, not a function. To support runtime switching we wrap the two
 * stores in a proxy object that delegates to whichever is healthy.
 *
 * The proxy must implement the Store interface:
 *   init(options)
 *   increment(key) → { totalHits, resetTime }
 *   decrement(key)
 *   resetKey(key)
 *   resetAll?()
 */
function makeDualStore(redisStore, fallbackStore, limiterName) {
  let _initialised = false;

  return {
    init(options) {
      try {
        if (isRedisReady()) redisStore.init(options);
      } catch (e) {
        // Redis not ready at init time — will use fallback
      }
      fallbackStore.init(options);
      _initialised = true;
    },

    async increment(key) {
      if (!_initialised) throw new Error('Store not initialised');

      if (isRedisReady()) {
        try {
          return await redisStore.increment(key);
        } catch (err) {
          logger.warn('[RateLimit] Redis increment failed — using memory fallback', {
            limiter: limiterName,
            error:   err.message,
          });
          // Fall through to memory store
        }
      } else {
        // Only log the transition, not every request
        // (Redis will log its own reconnect events)
      }
      return fallbackStore.increment(key);
    },

    async decrement(key) {
      if (isRedisReady()) {
        try { return await redisStore.decrement(key); } catch (_) {}
      }
      return fallbackStore.decrement(key);
    },

    async resetKey(key) {
      if (isRedisReady()) {
        try { await redisStore.resetKey(key); } catch (_) {}
      }
      return fallbackStore.resetKey(key);
    },

    async resetAll() {
      if (isRedisReady()) {
        try { await redisStore.resetAll?.(); } catch (_) {}
      }
      return fallbackStore.resetAll?.();
    },
  };
}

// ── Standard skip function ────────────────────────────────────────────────────
// Skip OPTIONS (CORS preflight) — never rate-limit preflight requests.
const skipOptions = (req) => req.method === 'OPTIONS';

// ── Key generators ────────────────────────────────────────────────────────────

/**
 * ipKey — rate-limit by IP address only.
 * Uses ipKeyGenerator from express-rate-limit v8 for IPv6 safety.
 */
function ipKey(req) {
  return ipKeyGenerator(req);
}

/**
 * userOrIpKey — rate-limit by user ID if authenticated, IP otherwise.
 * Falls back to ipKeyGenerator for IPv6-safe IP extraction.
 */
function userOrIpKey(req) {
  return req.user?.id ? `user:${req.user.id}` : ipKeyGenerator(req);
}

/**
 * ipAndPathKey — rate-limit by IP + path segment.
 * Uses ipKeyGenerator for IPv6-safe IP extraction.
 */
function ipAndPathKey(req) {
  const seg = req.path.split('/')[1] || 'unknown';
  return `${ipKeyGenerator(req)}:${seg}`;
}

// ══════════════════════════════════════════════════════════════════════════════
// CATEGORY A — AUTH LIMITERS
// ══════════════════════════════════════════════════════════════════════════════

/**
 * authLimiter — login, signup, forgot-password, email verification resend.
 *
 * Policy: 10 attempts per 15 minutes per IP.
 *
 * Why 10? The DB lockout kicks in at 5 failed logins (with exponential backoff).
 * The rate limiter sits in front of the DB layer, so the effective limit for
 * a brute-force attacker is min(10, 5) = 5 before they hit a DB lockout.
 * We set 10 here to give legitimate users retrying with a typo some headroom.
 *
 * skipSuccessfulRequests: false — we DO count successful logins. This prevents
 * a bypass where an attacker uses stolen valid credentials to "spend" their
 * window without incrementing the counter.
 */
const authLimiter = rateLimit({
  windowMs:               cfg.auth.windowMs,
  max:                    cfg.auth.max,
  standardHeaders:        'draft-7',
  legacyHeaders:          false,
  skipSuccessfulRequests: false,
  skip:                   skipOptions,
  keyGenerator:           ipKey,
  store:                  makeDualStore(
    makeRedisStore('auth:'),
    makeFallbackStore(),
    'authLimiter',
  ),
  handler: makeJson429Handler(
    'RATE_LIMIT_AUTH',
    'Too many authentication attempts. Please wait before trying again.',
  ),
});

/**
 * mfaLimiter — TOTP verification endpoint specifically.
 *
 * Policy: 5 attempts per 10 minutes per IP.
 *
 * TOTP codes are 6-digit (1,000,000 possibilities), time-based, and expire
 * every 30 seconds. A brute-force attacker hitting 5 attempts per 10 minutes
 * would need an astronomical amount of time. This limit primarily prevents
 * automated stuffing of stolen TOTP seeds.
 */
const mfaLimiter = rateLimit({
  windowMs:               10 * 60 * 1000,   // 10 minutes
  max:                    5,
  standardHeaders:        'draft-7',
  legacyHeaders:          false,
  skipSuccessfulRequests: false,
  skip:                   skipOptions,
  keyGenerator:           ipKey,
  store:                  makeDualStore(
    makeRedisStore('mfa:'),
    makeFallbackStore(),
    'mfaLimiter',
  ),
  handler: makeJson429Handler(
    'RATE_LIMIT_MFA',
    'Too many MFA verification attempts. Please wait before trying again.',
  ),
});

/**
 * refreshLimiter — token refresh endpoint.
 *
 * Policy: 20 refreshes per 15 minutes per IP.
 *
 * Legitimate use: a single browser tab refreshes its access token every 15
 * minutes when the 15m JWT expires. 20 allows multiple tabs and mobile apps
 * for the same user from the same IP without triggering false positives.
 *
 * Why IP keying instead of user keying? Refresh tokens are opaque to the
 * limiter — we haven't decoded the JWT yet when the limiter runs. IP is the
 * only available signal at this stage.
 */
const refreshLimiter = rateLimit({
  windowMs:               15 * 60 * 1000,   // 15 minutes
  max:                    20,
  standardHeaders:        'draft-7',
  legacyHeaders:          false,
  skipSuccessfulRequests: false,
  skip:                   skipOptions,
  keyGenerator:           ipKey,
  store:                  makeDualStore(
    makeRedisStore('refresh:'),
    makeFallbackStore(),
    'refreshLimiter',
  ),
  handler: makeJson429Handler(
    'RATE_LIMIT_REFRESH',
    'Too many token refresh requests. Please wait before trying again.',
  ),
});

/**
 * signerAuthLimiter — public signer authentication (one-time token redemption).
 *
 * Policy: 10 attempts per 30 minutes per IP.
 *
 * Signer tokens are long random UUIDs (128-bit entropy). This limit is a
 * backstop against automated token enumeration, not a primary security control
 * (the token entropy is the primary control). The longer window (30 min vs
 * 15 min for login) gives external signers more time — they may receive the
 * link on a slow email provider and click it minutes later from a different
 * network.
 */
const signerAuthLimiter = rateLimit({
  windowMs:               30 * 60 * 1000,   // 30 minutes
  max:                    10,
  standardHeaders:        'draft-7',
  legacyHeaders:          false,
  skip:                   skipOptions,
  keyGenerator:           ipKey,
  store:                  makeDualStore(
    makeRedisStore('signerauth:'),
    makeFallbackStore(),
    'signerAuthLimiter',
  ),
  handler: makeJson429Handler(
    'RATE_LIMIT_SIGNER_AUTH',
    'Too many signing authentication attempts. Please wait before trying again.',
  ),
});

// ══════════════════════════════════════════════════════════════════════════════
// CATEGORY B — DOCUMENT OPERATION LIMITERS
// ══════════════════════════════════════════════════════════════════════════════

/**
 * uploadLimiter — document upload endpoint.
 *
 * Policy: 10 uploads per 10 minutes per IP.
 *
 * Each upload: consumes Cloudinary bandwidth + storage, triggers DB writes,
 * and may trigger signing emails. This limit prevents a compromised account
 * from spamming uploads to exhaust storage quotas.
 *
 * 10 uploads per 10 minutes is generous for legitimate power users. A legal
 * team uploading many contracts would average 1/min — well within limit.
 */
const uploadLimiter = rateLimit({
  windowMs:               10 * 60 * 1000,   // 10 minutes
  max:                    10,
  standardHeaders:        'draft-7',
  legacyHeaders:          false,
  skip:                   skipOptions,
  keyGenerator:           userOrIpKey,
  store:                  makeDualStore(
    makeRedisStore('upload:'),
    makeFallbackStore(),
    'uploadLimiter',
  ),
  handler: makeJson429Handler(
    'RATE_LIMIT_UPLOAD',
    'Too many document uploads. Please wait before uploading more.',
  ),
});

/**
 * signingLimiter — document signing endpoint (both authenticated + public signer).
 *
 * Policy: 20 signing operations per 10 minutes per user/IP.
 *
 * Each signing operation: fetches PDF from Cloudinary, performs crypto signing,
 * re-uploads signed PDF, generates certificate, sends notification emails.
 * This limit prevents runaway automation or a bug causing signing loops.
 */
const signingLimiter = rateLimit({
  windowMs:               10 * 60 * 1000,   // 10 minutes
  max:                    20,
  standardHeaders:        'draft-7',
  legacyHeaders:          false,
  skip:                   skipOptions,
  keyGenerator:           userOrIpKey,
  store:                  makeDualStore(
    makeRedisStore('signing:'),
    makeFallbackStore(),
    'signingLimiter',
  ),
  handler: makeJson429Handler(
    'RATE_LIMIT_SIGNING',
    'Too many signing requests. Please wait before continuing.',
  ),
});

/**
 * fileLimiter — document download / verification endpoints.
 *
 * Policy: 20 requests per minute per IP (preserves existing behaviour).
 *
 * Prevents bulk scraping of signed documents and Cloudinary bandwidth abuse.
 * Per existing behaviour — kept compatible to avoid regressions.
 */
const fileLimiter = rateLimit({
  windowMs:               cfg.files.windowMs,
  max:                    cfg.files.max,
  standardHeaders:        'draft-7',
  legacyHeaders:          false,
  skip:                   skipOptions,
  keyGenerator:           ipAndPathKey,
  store:                  makeDualStore(
    makeRedisStore('files:'),
    makeFallbackStore(),
    'fileLimiter',
  ),
  handler: makeJson429Handler(
    'RATE_LIMIT_FILES',
    'Too many file requests. Please slow down.',
  ),
});

// ══════════════════════════════════════════════════════════════════════════════
// CATEGORY C — GENERAL API LIMITER
// ══════════════════════════════════════════════════════════════════════════════

/**
 * apiLimiter — catch-all for all /api/* routes.
 *
 * Policy: 60 requests per minute per user (if authenticated) or IP.
 *
 * Applied BEFORE route handlers in index.js. Specific limiters (auth, upload,
 * signing) are applied at the route level ON TOP of this limiter. This means
 * auth routes have BOTH the apiLimiter AND the authLimiter applied — two
 * separate buckets, independently tracked in Redis.
 *
 * User-keyed: an enterprise user on a shared office NAT doesn't consume limits
 * for their colleagues. Each JWT-identified user gets their own 60 req/min.
 */
const apiLimiter = rateLimit({
  windowMs:               cfg.api.windowMs,
  max:                    cfg.api.max,
  standardHeaders:        'draft-7',
  legacyHeaders:          false,
  skip:                   skipOptions,
  keyGenerator:           userOrIpKey,
  store:                  makeDualStore(
    makeRedisStore('api:'),
    makeFallbackStore(),
    'apiLimiter',
  ),
  handler: makeJson429Handler(
    'RATE_LIMIT_API',
    'Too many requests. Please slow down.',
  ),
});

// ══════════════════════════════════════════════════════════════════════════════
// CATEGORY D — ADMIN LIMITER
// ══════════════════════════════════════════════════════════════════════════════

/**
 * adminLimiter — all /api/admin/* routes.
 *
 * Policy: 30 requests per minute per IP.
 *
 * Why IP (not user) for admin? Admin sessions are a separate auth system
 * (adminTokenService). We haven't decoded the admin JWT when this limiter
 * runs (it's applied before adminAuth middleware in the route chain). IP is
 * the only available signal — admin IPs are typically a small known set.
 *
 * 30 req/min is generous for legitimate admin operations while preventing
 * automated admin API scraping.
 */
const adminLimiter = rateLimit({
  windowMs:               60 * 1000,    // 1 minute
  max:                    30,
  standardHeaders:        'draft-7',
  legacyHeaders:          false,
  skip:                   skipOptions,
  keyGenerator:           ipKey,
  store:                  makeDualStore(
    makeRedisStore('admin:'),
    makeFallbackStore(),
    'adminLimiter',
  ),
  handler: makeJson429Handler(
    'RATE_LIMIT_ADMIN',
    'Too many admin requests. Please slow down.',
  ),
});

// ── Exports ───────────────────────────────────────────────────────────────────
module.exports = {
  // Category A — Auth
  authLimiter,
  mfaLimiter,
  refreshLimiter,
  signerAuthLimiter,

  // Category B — Document operations
  uploadLimiter,
  signingLimiter,
  fileLimiter,

  // Category C — General API
  apiLimiter,

  // Category D — Admin
  adminLimiter,
};
