'use strict';

/**
 * tokenService.js
 *
 * Single source of truth for all JWT operations.
 * Keeps routes thin — no jwt.sign() calls anywhere else.
 *
 * Access token  — short-lived (15m), sent in JSON response body.
 *                 Client stores in memory only (not localStorage).
 * Refresh token — long-lived (7d), stored in DB + HttpOnly cookie.
 *                 On each use it is rotated: old token deleted, new issued.
 *                 This means a stolen refresh token can only be used once
 *                 before the legitimate client's next request invalidates it
 *                 and locks both parties out — detectable anomaly.
 */

const jwt    = require('jsonwebtoken');
const crypto = require('crypto');
const pool   = require('../config/database');
const { jwt: jwtCfg, cookie: cookieCfg } = require('../config/security');

if (!jwtCfg.secret) {
  throw new Error('FATAL: JWT_SECRET is not set.');
}

const SIGN_OPTS = {
  issuer:   jwtCfg.issuer,
  audience: jwtCfg.audience,
};

// ── Access token ──────────────────────────────────────────────────────────────

function issueAccessToken(user) {
  return jwt.sign(
    { id: user.id, email: user.email, mfa_verified: user.mfa_verified || false },
    jwtCfg.secret,
    { ...SIGN_OPTS, expiresIn: jwtCfg.accessExpiresIn }
  );
}

function verifyAccessToken(token) {
  // Throws on any failure — caller handles the error type
  return jwt.verify(token, jwtCfg.secret, SIGN_OPTS);
}

// ── Refresh token ─────────────────────────────────────────────────────────────

/**
 * Issues a new refresh token, stores its SHA-256 hash in the DB,
 * and sets it as an HttpOnly cookie on the response.
 *
 * We store the HASH, not the raw token, so a DB breach doesn't yield
 * usable refresh tokens (same principle as password hashing).
 */
async function issueRefreshToken(user, res) {
  const raw   = crypto.randomBytes(64).toString('hex');   // 128 hex chars
  const hash  = crypto.createHash('sha256').update(raw).digest('hex');
  const expiresAt = new Date(Date.now() + jwtCfg.refreshExpiresMs);

  await pool.query(
    `INSERT INTO refresh_tokens (user_id, token_hash, expires_at)
     VALUES ($1, $2, $3)`,
    [user.id, hash, expiresAt]
  );

  // Set HttpOnly cookie — JS cannot read this
  res.cookie(cookieCfg.name, raw, {
    httpOnly: cookieCfg.httpOnly,
    secure:   cookieCfg.secure,
    sameSite: cookieCfg.sameSite,
    path:     cookieCfg.path,
    expires:  expiresAt,
  });

  return hash;   // returned so callers can log the token ID if needed
}

/**
 * Rotates a refresh token:
 *   1. Validates the incoming raw token against DB hash
 *   2. Checks expiry and revocation status
 *   3. Deletes the old token (one-time use)
 *   4. Issues a new access + refresh token pair
 *
 * If the token is not found or already used → possible replay attack.
 * We revoke ALL tokens for this user as a precaution.
 */
async function rotateRefreshToken(rawToken, res) {
  if (!rawToken || typeof rawToken !== 'string') {
    throw Object.assign(new Error('No refresh token.'), { status: 401 });
  }

  const hash = crypto.createHash('sha256').update(rawToken).digest('hex');

  const result = await pool.query(
    `SELECT rt.*, u.id as uid, u.email, u.mfa_enabled
     FROM refresh_tokens rt
     JOIN users u ON u.id = rt.user_id
     WHERE rt.token_hash = $1`,
    [hash]
  );

  const record = result.rows[0];

  // Token not found → possible replay after rotation
  if (!record) {
    // We don't know which user this token belonged to without the hash match,
    // so we can't mass-revoke. Just reject.
    throw Object.assign(new Error('Invalid refresh token.'), { status: 401 });
  }

  // Token already revoked
  if (record.revoked) {
    // Revoke ALL tokens for this user — token theft detected
    await pool.query(
      `UPDATE refresh_tokens SET revoked = TRUE WHERE user_id = $1`,
      [record.user_id]
    );
    throw Object.assign(
      new Error('Refresh token reuse detected. All sessions invalidated.'),
      { status: 401 }
    );
  }

  // Token expired
  if (new Date() > new Date(record.expires_at)) {
    await pool.query(`DELETE FROM refresh_tokens WHERE id = $1`, [record.id]);
    throw Object.assign(new Error('Refresh token expired.'), { status: 401 });
  }

  // Revoke old token (rotation — each token is single-use)
  await pool.query(`UPDATE refresh_tokens SET revoked = TRUE WHERE id = $1`, [record.id]);

  const user = { id: record.uid, email: record.email };
  const accessToken = issueAccessToken(user);
  await issueRefreshToken(user, res);

  return { accessToken, user };
}

/**
 * Revokes a single refresh token (logout).
 * Clears the cookie regardless of whether the token was found.
 */
async function revokeRefreshToken(rawToken, res) {
  // Always clear the cookie
  res.clearCookie(cookieCfg.name, {
    httpOnly: cookieCfg.httpOnly,
    secure:   cookieCfg.secure,
    sameSite: cookieCfg.sameSite,
    path:     cookieCfg.path,
  });

  if (!rawToken) return;

  const hash = crypto.createHash('sha256').update(rawToken).digest('hex');
  await pool.query(
    `UPDATE refresh_tokens SET revoked = TRUE WHERE token_hash = $1`,
    [hash]
  );
}

/**
 * Revokes all refresh tokens for a user (logout everywhere / security incident).
 */
async function revokeAllUserTokens(userId, res) {
  res.clearCookie(cookieCfg.name, {
    httpOnly: cookieCfg.httpOnly,
    secure:   cookieCfg.secure,
    sameSite: cookieCfg.sameSite,
    path:     cookieCfg.path,
  });
  await pool.query(
    `UPDATE refresh_tokens SET revoked = TRUE WHERE user_id = $1`,
    [userId]
  );
}

/**
 * Periodic cleanup — called at startup and can be scheduled with setInterval.
 * Removes tokens expired more than 24h ago to keep the table small.
 */
async function pruneExpiredTokens() {
  const result = await pool.query(
    `DELETE FROM refresh_tokens
     WHERE expires_at < NOW() - INTERVAL '24 hours'`
  );
  if (result.rowCount > 0) {
    console.log(`[tokenService] Pruned ${result.rowCount} expired refresh tokens.`);
  }
}

module.exports = {
  issueAccessToken,
  verifyAccessToken,
  issueRefreshToken,
  rotateRefreshToken,
  revokeRefreshToken,
  revokeAllUserTokens,
  pruneExpiredTokens,
};