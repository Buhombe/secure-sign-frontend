'use strict';

const express      = require('express');
const cors         = require('cors');
const helmet       = require('helmet');
const cookieParser = require('cookie-parser');
require('dotenv').config();

const { cors: corsCfg, isProduction, trustProxy } = require('./config/security');

const authRoutes       = require('./routes/auth');
const documentRoutes   = require('./routes/documents');
const auditRoutes      = require('./routes/audit');
const signatureRoutes  = require('./routes/signatures');
const signerRoutes     = require('./routes/signers');
const adminAuthRoutes  = require('./routes/adminAuth');
const adminUsersRoutes = require('./routes/adminUsers');
const adminDataRoutes  = require('./routes/adminData');
const httpsOnly        = require('./middleware/httpsOnly');
const { apiLimiter }   = require('./middleware/rateLimiter');
const auditMiddleware  = require('./middleware/auditMiddleware');
const { pruneExpiredTokens } = require('./services/tokenService');

// ── Structured JSON logger (Fix 5) ───────────────────────────────────────────
// Outputs JSON lines that Railway (and any log aggregator) can index and search.
// No new dependencies — wraps the native console with a consistent JSON format.
const logger = {
  info:  (msg, meta = {}) => console.log(JSON.stringify({
    level: 'info',  msg, ...meta, time: new Date().toISOString(), env: process.env.NODE_ENV,
  })),
  warn:  (msg, meta = {}) => console.warn(JSON.stringify({
    level: 'warn',  msg, ...meta, time: new Date().toISOString(), env: process.env.NODE_ENV,
  })),
  error: (msg, meta = {}) => console.error(JSON.stringify({
    level: 'error', msg, ...meta, time: new Date().toISOString(), env: process.env.NODE_ENV,
  })),
  http:  (method, path, status, ms) => console.log(JSON.stringify({
    level: 'http', method, path, status, ms, time: new Date().toISOString(),
  })),
};

// Export logger so services can use it (optional — they can also require directly)
global._logger = logger;

// ─────────────────────────────────────────────────────────────────────────────

const app  = express();
const PORT = process.env.PORT || 5000;

if (trustProxy) app.set('trust proxy', 1);

app.use(httpsOnly);

app.use(helmet({
  hsts: { maxAge: 31536000, includeSubDomains: true, preload: true },
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'none'"], scriptSrc: ["'none'"], styleSrc: ["'none'"],
      imgSrc:     ["'none'"], connectSrc: ["'self'"], fontSrc:  ["'none'"],
      objectSrc:  ["'none'"], mediaSrc:  ["'none'"], frameSrc: ["'none'"],
    },
  },
  noSniff: true, frameguard: { action: 'deny' },
  hidePoweredBy: true, referrerPolicy: { policy: 'no-referrer' },
  permittedCrossDomainPolicies: { permittedPolicies: 'none' },
}));

app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    if (corsCfg.origins.includes(origin)) return callback(null, true);
    callback(new Error(`CORS: origin '${origin}' not allowed.`));
  },
  credentials: corsCfg.credentials,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  exposedHeaders: ['RateLimit-Limit', 'RateLimit-Remaining', 'RateLimit-Reset'],
}));

app.use(cookieParser());
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

// Structured HTTP request logger — path only, never query strings
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => logger.http(req.method, req.path, res.statusCode, Date.now() - start));
  next();
});

// Audit middleware — auto-logs failures and sensitive actions
app.use('/api', auditMiddleware);
app.use('/api', apiLimiter);

// NOTE: /uploads static middleware removed (Fix 3).
// Profile photos are served via authenticated GET /api/auth/photo/:filename

app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

// User routes
app.use('/api/auth',       authRoutes);
app.use('/api/documents',  documentRoutes);
app.use('/api/audit',      auditRoutes);
app.use('/api/signatures', signatureRoutes);
app.use('/api/signers',    signerRoutes);

// Admin routes
app.use('/api/admin/auth',  adminAuthRoutes);
app.use('/api/admin/users', adminUsersRoutes);
app.use('/api/admin',       adminDataRoutes);

app.use((req, res) => res.status(404).json({ error: 'Route not found.' }));

app.use((err, req, res, _next) => {
  logger.error('Unhandled error', { message: err.message, stack: isProduction ? undefined : err.stack });
  const status = err.status || err.statusCode || 500;
  return res.status(status).json({
    error: isProduction ? 'An unexpected error occurred.' : err.message,
  });
});

app.listen(PORT, async () => {
  logger.info(`Server started`, { port: PORT, env: process.env.NODE_ENV || 'development' });
  await pruneExpiredTokens().catch(e => logger.error('Token prune failed', { message: e.message }));
  setInterval(
    () => pruneExpiredTokens().catch(e => logger.error('Token prune failed', { message: e.message })),
    6 * 60 * 60 * 1000
  );
});

module.exports = app;

