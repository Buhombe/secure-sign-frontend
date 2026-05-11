'use strict';

/**
 * redis.js — HakikiSign Production Redis Client
 *
 * ARCHITECTURE DECISIONS
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * WHY IOREDIS OVER THE `redis` NPM PACKAGE?
 * ─────────────────────────────────────────
 * ioredis has first-class built-in reconnect logic with exponential backoff,
 * cluster support, Sentinel support, and a promise-first API. The official
 * `redis` package (v4+) is fine too, but ioredis is the de-facto standard for
 * production Node.js deployments because its reconnect strategy is battle-tested
 * and does not require extra wrappers.
 *
 * WHY A SINGLETON CLIENT?
 * ────────────────────────
 * Node.js `require()` caches module exports. Every file that does
 * `require('../config/redis')` gets the same Redis client instance. This means:
 *   - One TCP connection (or connection pool) shared across limiters
 *   - One reconnect FSM — no competing reconnect loops
 *   - One set of event listeners — no duplicate log spam
 *
 * GRACEFUL DEGRADATION STRATEGY
 * ──────────────────────────────
 * When Redis is unreachable this module does NOT silently pass all requests
 * through. Instead:
 *   1. It sets `redisClient.status` to a known sentinel ('not_ready')
 *   2. Rate limiters call `isRedisReady()` before each operation
 *   3. If Redis is down, limiters fall back to a SHORT-WINDOW in-memory store
 *      with a fixed, conservative limit — NOT open access.
 *
 * This means: during a Redis outage, protection is degraded (not eliminated).
 * A 30-second window with 5 auth requests provides meaningful protection
 * even without distributed state. The trade-off is intentional:
 *   - Better than silently disabling limits (unsafe)
 *   - Better than returning 503 to all users (service-killing)
 *   - Slightly weaker than distributed Redis limits (acceptable short-term)
 *
 * RAILWAY DEPLOYMENT NOTES
 * ─────────────────────────
 * Railway provides Redis via the Redis plugin. The connection string is
 * exposed as REDIS_URL (format: redis://:password@host:port). Railway may
 * restart services unexpectedly — ioredis's autoReconnect handles this.
 * Railway's internal network is encrypted at the transport layer, but
 * REDIS_TLS=true should be set for any Redis instance exposed to the public
 * internet or if Railway's TLS plugin is used.
 *
 * CONNECTION LIFECYCLE
 * ─────────────────────
 * connect → ready → [commands] → [disconnect] → reconnecting → ready
 *
 * On graceful shutdown (SIGTERM/SIGINT) we call client.quit() which sends
 * a QUIT command to Redis, flushing any pending commands first. This is
 * preferable to client.disconnect() which drops the socket immediately.
 */

const Redis = require('ioredis');

const logger = require('./logger');

// ── Configuration ─────────────────────────────────────────────────────────────

const REDIS_URL        = process.env.REDIS_URL;
const REDIS_TLS        = process.env.REDIS_TLS === 'true';
const REDIS_KEY_PREFIX = process.env.REDIS_KEY_PREFIX || 'hakikisign:rl:';

// How long to wait between reconnect attempts (exponential backoff, capped).
const RECONNECT_BASE_DELAY_MS = 200;
const RECONNECT_MAX_DELAY_MS  = 10_000;  // 10 seconds max

// Command timeout — if a SET/GET hangs longer than this we treat Redis as down.
const COMMAND_TIMEOUT_MS = 3_000;

// ── Health state ─────────────────────────────────────────────────────────────
// Shared state used by isRedisReady() exported below.
let _redisReady = false;

// ── Client factory ────────────────────────────────────────────────────────────

function createRedisClient() {
  if (!REDIS_URL) {
    logger.warn('[Redis] REDIS_URL not set — Redis-backed rate limiting disabled. Using memory fallback.');
    return null;
  }

  const tlsOptions = REDIS_TLS
    ? { tls: { rejectUnauthorized: true } }
    : {};

  const client = new Redis(REDIS_URL, {
    // ── Connection ──────────────────────────────────────────────────────────
    connectTimeout:       COMMAND_TIMEOUT_MS,
    commandTimeout:       COMMAND_TIMEOUT_MS,
    maxRetriesPerRequest: 1,    // fail fast per-command; reconnect handles retry

    // ── Reconnect strategy ──────────────────────────────────────────────────
    // Called by ioredis each time a reconnect attempt is needed.
    // Returns delay in ms (or null to stop retrying).
    retryStrategy(times) {
      const delay = Math.min(
        RECONNECT_BASE_DELAY_MS * Math.pow(2, times - 1),
        RECONNECT_MAX_DELAY_MS,
      );
      logger.warn('[Redis] Reconnecting', { attempt: times, delayMs: delay });
      return delay;  // never return null — keep retrying forever
    },

    // ── Key prefix ──────────────────────────────────────────────────────────
    // All rate-limit keys are namespaced so they coexist safely with any other
    // Redis usage (sessions, queues, caches) on the same instance.
    keyPrefix: REDIS_KEY_PREFIX,

    // ── TLS ─────────────────────────────────────────────────────────────────
    ...tlsOptions,

    // ── Misc ────────────────────────────────────────────────────────────────
    enableOfflineQueue: true,   // allow init() commands to queue during startup
    //                             connection; they will execute once ready.
    //                             We disable queueing only for rate-limit commands
    //                             in the dual-store by checking isRedisReady() first.
    lazyConnect:        false,  // connect at startup so we know Redis health early
  });

  // ── Event handlers ────────────────────────────────────────────────────────

  client.on('connect', () => {
    logger.info('[Redis] TCP connection established');
  });

  client.on('ready', () => {
    _redisReady = true;
    logger.info('[Redis] Client ready — rate limiting backed by Redis');
  });

  client.on('error', (err) => {
    // ioredis emits 'error' on every failed connect attempt. We log it but
    // do NOT crash — retryStrategy will handle reconnection.
    if (_redisReady) {
      // Transition to not-ready only after we were previously healthy.
      // Avoids spam on the very first connection attempt if Redis isn't up yet.
      _redisReady = false;
    }
    logger.error('[Redis] Client error', {
      message: err.message,
      code:    err.code,
    });
  });

  client.on('close', () => {
    _redisReady = false;
    logger.warn('[Redis] Connection closed');
  });

  client.on('reconnecting', (delayMs) => {
    _redisReady = false;
    logger.warn('[Redis] Reconnecting', { delayMs });
  });

  client.on('end', () => {
    _redisReady = false;
    logger.warn('[Redis] Connection ended permanently (no more retries)');
  });

  return client;
}

// ── Singleton ─────────────────────────────────────────────────────────────────
const redisClient = createRedisClient();

// ── Health check ──────────────────────────────────────────────────────────────

/**
 * isRedisReady() — synchronous check used by rate limiters before each
 * operation. Returns true only when the connection is confirmed healthy.
 */
function isRedisReady() {
  if (!redisClient) return false;
  return _redisReady && redisClient.status === 'ready';
}

/**
 * pingRedis() — async liveness probe used by /api/health endpoint.
 * Returns { ok: true, latencyMs } or { ok: false, error }.
 */
async function pingRedis() {
  if (!redisClient) return { ok: false, error: 'REDIS_URL not configured' };
  try {
    const start = Date.now();
    await redisClient.ping();
    return { ok: true, latencyMs: Date.now() - start };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ── Graceful shutdown ─────────────────────────────────────────────────────────

async function shutdownRedis() {
  if (!redisClient) return;
  try {
    logger.info('[Redis] Shutting down — sending QUIT');
    await redisClient.quit();
    logger.info('[Redis] Shutdown complete');
  } catch (err) {
    logger.error('[Redis] Error during shutdown', { message: err.message });
    redisClient.disconnect();
  }
}

// Register shutdown handlers once — safe to call multiple times because
// Node.js deduplicates identical listeners.
process.once('SIGTERM', shutdownRedis);
process.once('SIGINT',  shutdownRedis);

// ── Exports ───────────────────────────────────────────────────────────────────
module.exports = { redisClient, isRedisReady, pingRedis, shutdownRedis };
