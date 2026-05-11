'use strict';

const rateLimit = require('express-rate-limit');
const { rateLimit: cfg } = require('../config/security');

/**
 * rateLimiter.js
 *
 * Three separate limiters so we can tune them independently:
 *
 *   authLimiter   — /api/auth/login, /api/auth/signup
 *                   Strict: 10 attempts per IP per 15 minutes.
 *                   Prevents brute-force and credential stuffing.
 *
 *   apiLimiter    — general authenticated API routes
 *                   60 req/min per IP — generous for normal use.
 *
 *   fileLimiter   — document download endpoints
 *                   20 req/min per IP — prevents bulk scraping.
 *
 * All limiters:
 *   - Use standard RateLimit-* headers (RFC draft)
 *   - Disable legacy X-RateLimit-* headers (leak internal info)
 *   - Return JSON (not HTML) on 429 so clients can parse it
 *   - Skip OPTIONS (pre-flight) requests
 */

function makeJson429Handler(message) {
  return (req, res) => {
    res.status(429).json({
      error: message,
      retryAfter: Math.ceil(res.getHeader('Retry-After') || 60),
    });
  };
}

const authLimiter = rateLimit({
  windowMs: cfg.auth.windowMs,
  max: cfg.auth.max,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skipSuccessfulRequests: false,   // count successful logins too (prevents bypass)
  skip: req => req.method === 'OPTIONS',
  handler: makeJson429Handler(
    'Too many authentication attempts. Please wait before trying again.'
  ),
});

const apiLimiter = rateLimit({
  windowMs: cfg.api.windowMs,
  max: cfg.api.max,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skip: req => req.method === 'OPTIONS',
  handler: makeJson429Handler('Too many requests. Please slow down.'),
});

const fileLimiter = rateLimit({
  windowMs: cfg.files.windowMs,
  max: cfg.files.max,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skip: req => req.method === 'OPTIONS',
  handler: makeJson429Handler('Too many file requests. Please slow down.'),
});

module.exports = { authLimiter, apiLimiter, fileLimiter };