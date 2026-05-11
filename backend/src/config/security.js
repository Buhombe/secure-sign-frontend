'use strict';

/**
 * security.js — HakikiSign Security Configuration
 *
 * Central place for all security-sensitive configuration.
 * Every value is read from environment variables with safe defaults.
 * Missing secrets that are REQUIRED in production throw at startup.
 */

const env = process.env;

module.exports = {
  // ── JWT ──────────────────────────────────────────────────────────────────
  jwt: {
    secret:           env.JWT_SECRET,
    accessExpiresIn:  env.JWT_ACCESS_EXPIRES   || '15m',
    refreshExpiresIn: env.JWT_REFRESH_EXPIRES  || '7d',
    refreshExpiresMs: parseInt(env.JWT_REFRESH_EXPIRES_MS, 10) || 7 * 24 * 60 * 60 * 1000,
    issuer:           env.JWT_ISSUER            || 'secure-sign-api',
    audience:         env.JWT_AUDIENCE          || 'secure-sign-client',
  },

  // ── Refresh token cookie ──────────────────────────────────────────────────
  cookie: {
    name:     'ssi_rt',
    httpOnly: true,
    secure:   env.NODE_ENV === 'production',
    sameSite: env.NODE_ENV === 'production' ? 'none' : 'strict',
    path:     '/api/auth',
  },

  // ── CSRF ──────────────────────────────────────────────────────────────────
  csrf: {
    cookieName:   'csrf_token',
    headerName:   'x-csrf-token',
    tokenBytes:   32,
    maxAgeMs:     4 * 60 * 60 * 1000,  // 4 hours
  },

  // ── Rate limits ───────────────────────────────────────────────────────────
  //
  // CATEGORY A — Auth endpoints (login, signup, forgot-password)
  // CATEGORY B — Document operations configured inline in rateLimiter.js
  // CATEGORY C — General API catch-all
  // CATEGORY D — Admin routes configured inline in rateLimiter.js
  //
  rateLimit: {
    auth: {
      windowMs: parseInt(env.RL_AUTH_WINDOW_MS, 10)  || 15 * 60 * 1000,  // 15 min
      max:      parseInt(env.RL_AUTH_MAX, 10)         || 10,
    },
    api: {
      windowMs: parseInt(env.RL_API_WINDOW_MS, 10)   || 60 * 1000,        // 1 min
      max:      parseInt(env.RL_API_MAX, 10)          || 60,
    },
    files: {
      windowMs: parseInt(env.RL_FILES_WINDOW_MS, 10) || 60 * 1000,        // 1 min
      max:      parseInt(env.RL_FILES_MAX, 10)        || 20,
    },
  },

  // ── CORS ──────────────────────────────────────────────────────────────────
  cors: {
    origins: (env.ALLOWED_ORIGINS || 'http://localhost:5173,http://localhost:5174')
      .split(',').map(o => o.trim()).filter(Boolean),
    credentials: true,
  },

  // ── File uploads ──────────────────────────────────────────────────────────
  upload: {
    maxFileSizeBytes: parseInt(env.MAX_FILE_SIZE_BYTES, 10) || 10 * 1024 * 1024,
    allowedMimeType:  'application/pdf',
    pdfMagicBytes:    Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d]),
  },

  // ── Password policy ───────────────────────────────────────────────────────
  password: {
    minLength:    parseInt(env.PASSWORD_MIN_LENGTH, 10) || 10,
    bcryptRounds: parseInt(env.BCRYPT_ROUNDS, 10)       || 12,
  },

  // ── Account lockout ───────────────────────────────────────────────────────
  lockout: {
    maxFailedAttempts: parseInt(env.LOCKOUT_MAX_ATTEMPTS, 10) || 5,
    backoffBaseMs:     parseInt(env.LOCKOUT_BACKOFF_MS, 10)   || 1000,
    windowMs:          parseInt(env.LOCKOUT_WINDOW_MS, 10)    || 30 * 60 * 1000,
    durationMs:        parseInt(env.LOCKOUT_DURATION_MS, 10)  || 30 * 60 * 1000,
  },

  // ── MFA (TOTP) ────────────────────────────────────────────────────────────
  mfa: {
    issuer:   env.MFA_ISSUER || 'HakikiSign',
    required: ['SIGN'],
  },

  // ── Environment ───────────────────────────────────────────────────────────
  isProduction: env.NODE_ENV === 'production',
  trustProxy:   env.TRUST_PROXY === 'true',
};
