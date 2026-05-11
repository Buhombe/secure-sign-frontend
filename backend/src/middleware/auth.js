'use strict';

const { verifyAccessToken } = require('../services/tokenService');
const { mfa } = require('../config/security');

/**
 * authMiddleware — verifies the Bearer access token in Authorization header.
 *
 * Sets req.user = { id, email, mfa_verified }
 * Distinguishes expired (401) from invalid (403) so clients can
 * trigger a refresh on 401 without prompting re-login on 403.
 */
function authMiddleware(req, res, next) {
  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Access denied. No token provided.' });
  }

  try {
    req.user = verifyAccessToken(authHeader.slice(7));
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Token expired.', code: 'TOKEN_EXPIRED' });
    }
    return res.status(403).json({ error: 'Invalid token.' });
  }
}

/**
 * requireMfa — applied after authMiddleware on sensitive routes (e.g. signing).
 *
 * If the user has MFA enabled, the access token MUST carry mfa_verified: true.
 * This flag is only set when the user completes TOTP verification after login.
 *
 * If the user has no MFA set up, they pass through freely — MFA is optional
 * but strongly encouraged (the client should prompt setup).
 */
async function requireMfa(req, res, next) {
  let mfaEnabled = req.user.mfa_enabled;

  if (mfaEnabled === undefined) {
    const pool = require('../config/database');
    const row  = await pool.query(
      'SELECT mfa_enabled FROM users WHERE id = $1', [req.user.id]
    );
    mfaEnabled = row.rows[0]?.mfa_enabled;
  }

  if (mfaEnabled && !req.user.mfa_verified) {
    return res.status(403).json({
      error: 'MFA verification required for this action.',
      code:  'MFA_REQUIRED',
    });
  }
  next();
}

/**
 * requireEmailVerified — Phase 2.
 *
 * Applied after authMiddleware on routes that must not be accessible until
 * the user has confirmed they control their email address.
 *
 * Protects: document upload, document signing (both flows).
 * Does NOT protect: login, logout, refresh, MFA setup, verify-email itself.
 *
 * We do a single DB lookup — the email_verified flag is not embedded in the
 * JWT so that verification takes effect immediately without requiring a
 * token refresh.
 */
async function requireEmailVerified(req, res, next) {
  try {
    const pool = require('../config/database');
    const result = await pool.query(
      'SELECT email_verified FROM users WHERE id = $1',
      [req.user.id]
    );

    if (!result.rows[0]) {
      return res.status(401).json({ error: 'User not found.' });
    }

    if (!result.rows[0].email_verified) {
      return res.status(403).json({
        error: 'Please verify your email address before continuing. Check your inbox for the verification link.',
        code:  'EMAIL_NOT_VERIFIED',
      });
    }

    next();
  } catch (err) {
    console.error('[requireEmailVerified] DB error:', err.message);
    return res.status(500).json({ error: 'Could not verify account status.' });
  }
}

module.exports = authMiddleware;
module.exports.requireMfa           = requireMfa;
module.exports.requireEmailVerified = requireEmailVerified;
