'use strict';

/**
 * index.js — HakikiSign API Server
 *
 * MIDDLEWARE ORDERING — WHY EVERY POSITION MATTERS
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * 1. app.set('trust proxy', 1)
 *    MUST be set before any middleware reads req.ip or req.secure.
 *    Without this, req.secure = false (Railway's proxy strips HTTPS) and
 *    the httpsOnly redirect loops forever. Also required for correct req.ip
 *    in audit logs and rate-limit counters (otherwise all IPs are the
 *    Railway proxy's IP — forensically worthless).
 *
 * 2. httpsOnly
 *    SECOND — before any processing. Redirects HTTP → HTTPS.
 *
 * 3. helmet
 *    THIRD — sets security response headers on every response.
 *
 * 4. cors
 *    FOURTH — must run before cookieParser so OPTIONS preflight requests
 *    receive correct CORS headers before the browser sends the real request.
 *
 * 5. cookieParser(CSRF_COOKIE_SECRET)
 *    FIFTH — must run before csrfProtect which reads req.signedCookies.
 *
 * 6. express.json / express.urlencoded
 *    SIXTH — body parsing before route handlers.
 *
 * 7. HTTP request logger
 *    SEVENTH — after body parsing, before business middleware.
 *
 * 8. auditMiddleware (scoped to /api)
 *    EIGHTH — before rate limiting so audit records reflect ALL requests
 *    including rate-limited ones.
 *
 * 9. apiLimiter (scoped to /api)
 *    NINTH — after audit so we log rate-limited requests, before CSRF so
 *    we drop abusive clients before expensive crypto operations.
 *
 * 10. adminLimiter (scoped to /api/admin)
 *     TENTH — admin routes get an additional per-category limit on top of
 *     the global apiLimiter (two independent Redis buckets). Applied here
 *     at the app level so it runs before csrfProtect and route handlers.
 *
 * 11. GET /api/auth/csrf-token  ← CSRF BOOTSTRAP ENDPOINT
 *     Registered BEFORE app.use('/api', csrfProtect) — never blocked.
 *
 * 12. GET /api/health
 *     Health check — no auth, no CSRF, no per-route rate limit.
 *     Now includes Redis health from pingRedis().
 *
 * 13. app.use('/api', csrfProtect)   ← CSRF PROTECTION
 *
 * 14. Route handlers
 *
 * 15. 404 handler
 *
 * 16. Global error handler
 */

const express      = require('express');
const cors         = require('cors');
const helmet       = require('helmet');
const cookieParser = require('cookie-parser');
require('dotenv').config();

// ── Use shared logger (extracted from index.js to break circular deps) ────────
const logger = require('./config/logger');
// Re-export so other modules that previously required logger from index.js still work
module.exports.logger = logger;

const { cors: corsCfg, isProduction, trustProxy } = require('./config/security');

const authRoutes       = require('./routes/auth');
const documentRoutes   = require('./routes/documents');
const auditRoutes      = require('./routes/audit');
const signatureRoutes  = require('./routes/signatures');
const signerRoutes     = require("./routes/signers");
const declineRoutes    = require("./routes/decline");
const fieldRoutes      = require('./routes/fields');
const adminAuthRoutes  = require('./routes/adminAuth');
const adminUsersRoutes = require('./routes/adminUsers');
const adminDataRoutes  = require('./routes/adminData');
const httpsOnly        = require('./middleware/httpsOnly');
const { apiLimiter, adminLimiter } = require('./middleware/rateLimiter');
const auditMiddleware  = require('./middleware/auditMiddleware');
const {
  csrfProtect,
  csrfTokenRoute,
} = require('./middleware/csrf');
const { pruneExpiredTokens } = require('./services/tokenService');

// ── Redis — import to trigger client connection at startup ─────────────────────
// The side effect of requiring redis.js is that ioredis begins connecting.
// We also need pingRedis for the health endpoint.
const { pingRedis, shutdownRedis } = require('./config/redis');

// ── Validate required secrets at startup ─────────────────────────────────────
if (!process.env.CSRF_COOKIE_SECRET || process.env.CSRF_COOKIE_SECRET.length < 32) {
  throw new Error(
    'FATAL: CSRF_COOKIE_SECRET must be set and at least 32 characters long. ' +
    'Generate with: openssl rand -hex 32'
  );
}

if (!process.env.REDIS_URL) {
  logger.warn(
    'REDIS_URL not set. Rate limiting will use in-memory fallback. ' +
    'This is NOT safe for production horizontal scaling. ' +
    'Add a Redis plugin to your Railway project and set REDIS_URL.'
  );
}

const app  = express();
const PORT = process.env.PORT || 5000;

// ─────────────────────────────────────────────────────────────────────────────
// STEP 1: Trust proxy
// ─────────────────────────────────────────────────────────────────────────────
if (trustProxy) {
  app.set('trust proxy', 1);
  logger.info('Trust proxy enabled — req.ip will reflect real client IP');
} else if (isProduction) {
  logger.warn('TRUST_PROXY not set in production. req.ip will be the proxy IP. Set TRUST_PROXY=true in Railway.');
}

// ─────────────────────────────────────────────────────────────────────────────
// STEP 2: HTTPS enforcement
// ─────────────────────────────────────────────────────────────────────────────
app.use(httpsOnly);

// ─────────────────────────────────────────────────────────────────────────────
// STEP 3: Security headers (Helmet)
// ─────────────────────────────────────────────────────────────────────────────
app.use(helmet({
  hsts: {
    maxAge:            31536000,
    includeSubDomains: true,
    preload:           true,
  },
  contentSecurityPolicy: {
    directives: {
      defaultSrc:  ["'none'"],
      scriptSrc:   ["'none'"],
      styleSrc:    ["'none'"],
      imgSrc:      ["'none'"],
      connectSrc:  ["'self'"],
      fontSrc:     ["'none'"],
      objectSrc:   ["'none'"],
      mediaSrc:    ["'none'"],
      frameSrc:    ["'none'"],
    },
  },
  noSniff:                     true,
  frameguard:                  { action: 'deny' },
  hidePoweredBy:               true,
  referrerPolicy:              { policy: 'no-referrer' },
  permittedCrossDomainPolicies: { permittedPolicies: 'none' },
  crossOriginEmbedderPolicy:   true,
  crossOriginOpenerPolicy:     { policy: 'same-origin' },
  crossOriginResourcePolicy:   { policy: 'cross-origin' },
}));

// ─────────────────────────────────────────────────────────────────────────────
// STEP 4: CORS
// ─────────────────────────────────────────────────────────────────────────────
app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    if (corsCfg.origins.includes(origin)) return callback(null, true);
    logger.warn('CORS blocked request from disallowed origin', { origin });
    callback(new Error(`CORS: origin '${origin}' not allowed.`));
  },
  credentials:     true,
  methods:         ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders:  ['Content-Type', 'Authorization', 'X-CSRF-Token'],
  exposedHeaders:  ['RateLimit-Limit', 'RateLimit-Remaining', 'RateLimit-Reset', 'Retry-After'],
  maxAge:          86400,
}));

// ─────────────────────────────────────────────────────────────────────────────
// STEP 5: Cookie parser
// ─────────────────────────────────────────────────────────────────────────────
app.use(cookieParser(process.env.CSRF_COOKIE_SECRET));

// ─────────────────────────────────────────────────────────────────────────────
// STEP 6: Body parsing
// ─────────────────────────────────────────────────────────────────────────────
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

// ─────────────────────────────────────────────────────────────────────────────
// STEP 7: HTTP request logging
// ─────────────────────────────────────────────────────────────────────────────
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => logger.http(req.method, req.path, res.statusCode, Date.now() - start));
  next();
});

// ─────────────────────────────────────────────────────────────────────────────
// STEP 8 & 9: Audit + Rate limiting (scoped to /api)
// ─────────────────────────────────────────────────────────────────────────────
app.use('/api', auditMiddleware);
app.use('/api', apiLimiter);

// ─────────────────────────────────────────────────────────────────────────────
// STEP 10: Admin rate limit (scoped to /api/admin)
// Applied here — before CSRF and route handlers — so admin routes receive
// BOTH the global apiLimiter and the stricter adminLimiter.
// The two limiters use separate Redis key namespaces and track independently.
// ─────────────────────────────────────────────────────────────────────────────
app.use('/api/admin', adminLimiter);

// ─────────────────────────────────────────────────────────────────────────────
// STEP 11: CSRF token bootstrap endpoint
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/auth/csrf-token', csrfTokenRoute);

// ─────────────────────────────────────────────────────────────────────────────
// STEP 12: Health check
// Now includes Redis connectivity status for monitoring / Railway health probes.
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/health', async (req, res) => {
  const redis = await pingRedis();
  res.json({
    status:  'ok',
    ts:      Date.now(),
    redis,
    // Rate limiting mode is transparent to the health check consumer:
    rateLimiting: redis.ok ? 'redis' : 'memory-fallback',
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// STEP 13: CSRF PROTECTION
// ─────────────────────────────────────────────────────────────────────────────
app.use('/api', csrfProtect);

// ─────────────────────────────────────────────────────────────────────────────
// STEP 14: Route handlers
// ─────────────────────────────────────────────────────────────────────────────

// User-facing routes
app.use('/api/auth',       authRoutes);
app.use('/api/documents',  documentRoutes);
app.use('/api/audit',      auditRoutes);
app.use('/api/signatures', signatureRoutes);
app.use("/api/signers",    signerRoutes);
app.use("/api/signers",    declineRoutes);
app.use('/api/fields',     fieldRoutes);

// Admin routes
app.use('/api/admin/auth',  adminAuthRoutes);
app.use('/api/admin/users', adminUsersRoutes);
app.use('/api/admin',       adminDataRoutes);

// ─────────────────────────────────────────────────────────────────────────────
// STEP 15: 404 handler
// ─────────────────────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: 'Route not found.' });
});

// ─────────────────────────────────────────────────────────────────────────────
// STEP 16: Global error handler
// ─────────────────────────────────────────────────────────────────────────────
app.use((err, req, res, _next) => {
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Request payload too large.' });
  }
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Invalid JSON in request body.' });
  }
  if (err.message && err.message.startsWith('CORS:')) {
    return res.status(403).json({ error: err.message });
  }

  logger.error('Unhandled error', {
    message: err.message,
    stack:   isProduction ? undefined : err.stack,
    path:    req.path,
    method:  req.method,
  });

  const status = err.status || err.statusCode || 500;
  return res.status(status).json({
    error: isProduction ? 'An unexpected error occurred.' : err.message,
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Server startup
// ─────────────────────────────────────────────────────────────────────────────
const server = app.listen(PORT, async () => {
  logger.info('Server started', {
    port:         PORT,
    env:          process.env.NODE_ENV || 'development',
    csrf:         'ENABLED',
    proxy:        trustProxy ? 'trusted' : 'not-trusted',
    rateLimiting: process.env.REDIS_URL ? 'redis (connecting)' : 'memory-fallback',
  });

  await pruneExpiredTokens().catch(e =>
    logger.error('Initial token prune failed', { message: e.message })
  );

  // Prune expired refresh tokens every 6 hours
  setInterval(
    () => pruneExpiredTokens().catch(e =>
      logger.error('Token prune failed', { message: e.message })
    ),
    6 * 60 * 60 * 1000
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// Graceful shutdown — SIGTERM is sent by Railway on deploy/scale events.
// We close the HTTP server (stop accepting new connections) then shut down
// Redis. The HTTP server close() callback fires when in-flight requests finish.
// ─────────────────────────────────────────────────────────────────────────────
async function gracefulShutdown(signal) {
  logger.info(`Received ${signal} — beginning graceful shutdown`);

  server.close(async () => {
    logger.info('HTTP server closed');
    await shutdownRedis();
    logger.info('Graceful shutdown complete');
    process.exit(0);
  });

  // Force-exit after 15 seconds if in-flight requests don't finish
  setTimeout(() => {
    logger.error('Graceful shutdown timed out — forcing exit');
    process.exit(1);
  }, 15_000);
}

process.once('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.once('SIGINT',  () => gracefulShutdown('SIGINT'));

module.exports = app;
