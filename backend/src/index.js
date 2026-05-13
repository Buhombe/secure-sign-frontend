'use strict';

/**
 * index.js — HakikiSign Express Server (v2 — notification system integration)
 *
 * CHANGES FROM v1 (surgical, minimum-diff)
 * ──────────────────────────────────────────
 * 1. Import webhookRoutes and notificationPrefRoutes
 * 2. Register /api/webhooks BEFORE csrfProtect (webhooks use HMAC, not CSRF cookies)
 * 3. Register /api/notifications AFTER csrfProtect (user-authenticated)
 *
 * ALL OTHER MIDDLEWARE, SECURITY, CORS, HELMET, RATE LIMITING, AND ROUTE
 * REGISTRATION IS UNCHANGED. This diff is additive only.
 *
 * HOW TO APPLY
 * ─────────────
 * In your production index.js, apply these 4 changes:
 *
 *   CHANGE A — add two requires near the other route requires (~line 82-86):
 *     const webhookRoutes       = require('./routes/webhooks');
 *     const notifPrefRoutes     = require('./routes/notificationPreferences');
 *
 *   CHANGE B — register webhook route BEFORE app.use('/api', csrfProtect) (~line 208):
 *     // Webhook routes — MUST be before CSRF (webhooks use provider HMAC, not cookies)
 *     app.use('/api/webhooks', webhookRoutes);
 *
 *   CHANGE C — register notification prefs AFTER csrfProtect (~line 254):
 *     app.use('/api/notifications', notifPrefRoutes);
 *
 * That is the complete change to index.js.
 * The diff below shows the full file for clarity.
 */

require('dotenv').config();

const express       = require('express');
const helmet        = require('helmet');
const cors          = require('cors');
const cookieParser  = require('cookie-parser');
const { rateLimit } = require('express-rate-limit');

const logger        = require('./config/logger');
const { csrfProtect } = require('./middleware/csrf');
const auditMiddleware = require('./middleware/auditMiddleware');
const { apiLimiter, adminLimiter } = require('./middleware/rateLimiter');
const httpsOnly     = require('./middleware/httpsOnly');

// ── Route imports ─────────────────────────────────────────────────────────────
const authRoutes           = require('./routes/auth');
const documentRoutes       = require('./routes/documents');
const auditRoutes          = require('./routes/audit');
const signatureRoutes      = require('./routes/signatures');
const signerRoutes         = require('./routes/signers');
const declineRoutes        = require('./routes/decline');
const fieldRoutes          = require('./routes/fields');
const adminAuthRoutes      = require('./routes/adminAuth');
const adminUsersRoutes     = require('./routes/adminUsers');
const adminDataRoutes      = require('./routes/adminData');

// CHANGE A — new routes (notification system)
const webhookRoutes        = require('./routes/webhooks');
const notifPrefRoutes      = require('./routes/notificationPreferences');

const isProduction = process.env.NODE_ENV === 'production';
const PORT         = parseInt(process.env.PORT, 10) || 5000;

const app = express();

// ── Trust proxy (Railway) ─────────────────────────────────────────────────────
app.set('trust proxy', 1);

// ── HTTPS redirect ────────────────────────────────────────────────────────────
app.use(httpsOnly);

// ── Helmet security headers ───────────────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc:  ["'self'"],
      styleSrc:   ["'self'", "'unsafe-inline'"],
      imgSrc:     ["'self'", 'data:', 'https://res.cloudinary.com'],
      connectSrc: ["'self'"],
      fontSrc:    ["'self'"],
      objectSrc:  ["'none'"],
      frameAncestors: ["'none'"],
    },
  },
  crossOriginResourcePolicy: { policy: 'same-origin' },
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
}));

// ── CORS ──────────────────────────────────────────────────────────────────────
const allowedOrigins = (process.env.ALLOWED_ORIGINS || 'http://localhost:5173').split(',').map(o => o.trim());

app.use(cors({
  origin: (origin, cb) => {
    if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
    cb(new Error(`CORS: origin ${origin} not allowed`));
  },
  credentials:         true,
  allowedHeaders:      ['Content-Type', 'X-CSRF-Token'],
  exposedHeaders:      ['X-CSRF-Token'],
  methods:             ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  optionsSuccessStatus: 204,
}));

// ── Cookie parser ─────────────────────────────────────────────────────────────
app.use(cookieParser(process.env.CSRF_COOKIE_SECRET));

// ── Body parsing ──────────────────────────────────────────────────────────────
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

// ── Request ID ────────────────────────────────────────────────────────────────
app.use((req, _res, next) => {
  req.id = require('crypto').randomUUID();
  next();
});

// ── Audit middleware ──────────────────────────────────────────────────────────
app.use('/api', auditMiddleware);
app.use('/api', apiLimiter);
app.use('/api/admin', adminLimiter);

// ── Health check (no auth, no CSRF) ──────────────────────────────────────────
app.get('/health', (_req, res) => res.json({ status: 'ok', ts: new Date().toISOString() }));

// ─────────────────────────────────────────────────────────────────────────────
// CHANGE B — Webhook routes BEFORE CSRF protection
//
// WhatsApp (Twilio) and Brevo webhooks use provider-signed HMAC authentication.
// They cannot carry CSRF cookies. Must be registered BEFORE app.use('/api', csrfProtect).
//
// Security: webhookRoutes validates signatures internally (validateTwilioSignature,
// validateBrevoWebhook). No CSRF token needed or appropriate.
// ─────────────────────────────────────────────────────────────────────────────
app.use('/api/webhooks', webhookRoutes);

// ── CSRF protection (all subsequent /api routes) ──────────────────────────────
app.use('/api', csrfProtect);

// ── User-facing routes ────────────────────────────────────────────────────────
app.use('/api/auth',          authRoutes);
app.use('/api/documents',     documentRoutes);
app.use('/api/audit',         auditRoutes);
app.use('/api/signatures',    signatureRoutes);
app.use('/api/signers',       signerRoutes);
app.use('/api/signers',       declineRoutes);
app.use('/api/fields',        fieldRoutes);

// CHANGE C — Notification preferences (authenticated, behind CSRF)
app.use('/api/notifications', notifPrefRoutes);

// ── Admin routes ──────────────────────────────────────────────────────────────
app.use('/api/admin/auth',    adminAuthRoutes);
app.use('/api/admin/users',   adminUsersRoutes);
app.use('/api/admin',         adminDataRoutes);

// ── 404 handler ───────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: 'Route not found.' });
});

// ── Global error handler ──────────────────────────────────────────────────────
app.use((err, req, res, _next) => {
  if (err.type === 'entity.too.large')      return res.status(413).json({ error: 'Request payload too large.' });
  if (err.type === 'entity.parse.failed')   return res.status(400).json({ error: 'Invalid JSON in request body.' });
  if (err.message?.startsWith('CORS:'))     return res.status(403).json({ error: err.message });

  logger.error('Unhandled error', {
    message: err.message,
    stack:   isProduction ? undefined : err.stack,
    path:    req.path,
    method:  req.method,
  });

  const status = err.status || err.statusCode || 500;
  return res.status(status).json({ error: isProduction ? 'Internal server error.' : err.message });
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  logger.info(`[Server] HakikiSign API listening on port ${PORT}`, { port: PORT, env: process.env.NODE_ENV });
});

module.exports = app;
