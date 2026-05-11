'use strict';

const { verifyAccessToken } = require('../services/tokenService');

/**
 * optionalAuth — if a valid Bearer token is present, populate req.user.
 * If absent or invalid, set req.user = null and continue (no 401/403).
 *
 * Uses the same issuer/audience validation as authMiddleware so that tokens
 * issued for a different service cannot leak through as authenticated here.
 *
 * Phase 1 hardening: previously used raw jwt.verify(token, JWT_SECRET) which
 * skipped issuer/audience checks and mirrored logic already encapsulated
 * in tokenService. Routing through the service keeps validation consistent.
 */
module.exports = (req, res, next) => {
  req.user = null;

  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) return next();

  try {
    req.user = verifyAccessToken(authHeader.slice(7));
  } catch (_) {
    req.user = null;
  }
  next();
};
