'use strict';

const env = process.env;

module.exports = {
  // ── JWT ──────────────────────────────────────────────────────────────────
  jwt: {
    secret:              env.JWT_SECRET,
    accessExpiresIn:     env.JWT_ACCESS_EXPIRES   || '15m',
    refreshExpiresIn:    env.JWT_REFRESH_EXPIRES  || '7d',
    // Milliseconds — used for cookie maxAge and DB expiry calculation
    refreshExpiresMs:    parseInt(env.JWT_REFRESH_EXPIRES_MS, 10) || 7 * 24 * 60 * 60 * 1000,
    issuer:              env.JWT_ISSUER            || 'secure-sign-api',
    audience:            env.JWT_AUDIENCE          || 'secure-sign-client',
  },

  // ── Refresh token cookie ──────────────────────────────────────────────────
  cookie: {
    name:     'ssi_rt',           // short, non-descriptive name
    httpOnly: true,
    secure:   env.NODE_ENV === 'production',   // HTTPS only in prod
    sameSite: env.NODE_ENV === 'production' ? 'none' : 'strict', // 'none' required for cross-origin (Vercel <-> Railway)
    path:     '/api/auth',        // cookie only sent to auth routes
  },

  // ── Rate limits ───────────────────────────────────────────────────────────
  rateLimit: {
    auth: {
      windowMs: parseInt(env.RL_AUTH_WINDOW_MS, 10) || 15 * 60 * 1000,
      max:      parseInt(env.RL_AUTH_MAX, 10)        || 10,
    },
    api: {
      windowMs: parseInt(env.RL_API_WINDOW_MS, 10)  || 60 * 1000,
      max:      parseInt(env.RL_API_MAX, 10)         || 60,
    },
    files: {
      windowMs: parseInt(env.RL_FILES_WINDOW_MS, 10) || 60 * 1000,
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
    // Base delay in ms for exponential backoff: attempt^2 * base
    backoffBaseMs:     parseInt(env.LOCKOUT_BACKOFF_MS, 10)   || 1000,
    // How long (ms) before failed_attempts counter resets automatically
    windowMs:          parseInt(env.LOCKOUT_WINDOW_MS, 10)    || 30 * 60 * 1000, // 30 min
    // How long (ms) an account stays locked before auto-unlock
    durationMs:        parseInt(env.LOCKOUT_DURATION_MS, 10)  || 30 * 60 * 1000, // 30 min
  },

  // ── MFA (TOTP) ────────────────────────────────────────────────────────────
  mfa: {
    issuer:    env.MFA_ISSUER    || 'SecureSign',
    // Actions that require MFA if the user has it enabled
    required:  ['SIGN'],
  },

  // ── Environment ───────────────────────────────────────────────────────────
  isProduction: env.NODE_ENV === 'production',
  trustProxy:   env.TRUST_PROXY === 'true',
};