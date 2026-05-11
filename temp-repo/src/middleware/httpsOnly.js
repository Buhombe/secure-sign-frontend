'use strict';

const { isProduction } = require('../config/security');

/**
 * httpsOnly.js
 *
 * In production, rejects any request that did not arrive over TLS.
 * Works correctly behind a reverse proxy (nginx, ALB) that sets
 * the X-Forwarded-Proto header — requires `app.set('trust proxy', 1)`.
 *
 * 308 Permanent Redirect is used so the client method is preserved
 * (important for POST /api/auth/login etc.).
 */
module.exports = function httpsOnly(req, res, next) {
  if (!isProduction) return next();

  const proto = req.headers['x-forwarded-proto'] || req.protocol;
  if (proto !== 'https') {
    const secureUrl = `https://${req.hostname}${req.originalUrl}`;
    return res.redirect(308, secureUrl);
  }

  next();
};