'use strict';

const express  = require('express');
const router   = express.Router();
const bcrypt   = require('bcryptjs');
const crypto   = require('crypto');
const path     = require('path');
const fs       = require('fs');
const { authenticator } = require('otplib');
const qrcode   = require('qrcode');

const pool            = require('../config/database');
const { log, ACTIONS } = require('../services/auditService');
const authMiddleware  = require('../middleware/auth');
const { requireMfa }  = require('../middleware/auth');
const { authLimiter } = require('../middleware/rateLimiter');
const { validate }    = require('../middleware/sanitize');
const {
  jwt: jwtCfg, password: pwCfg,
  lockout: lockoutCfg, mfa: mfaCfg, cookie: cookieCfg,
} = require('../config/security');
const {
  issueAccessToken, issueRefreshToken,
  rotateRefreshToken, revokeRefreshToken, revokeAllUserTokens,
} = require('../services/tokenService');
const { encrypt, decrypt, hashToken } = require('../services/encryptionService');
const {
  sendVerificationEmail,
  sendPasswordResetEmail,
} = require('../services/emailService');
const { uploadPhoto, deletePhoto } = require('../services/storageService');
const { v4: uuidv4 } = require('uuid');

// ── Multer for profile photos — memory storage (Fix 4: Cloudinary) ────────────
// Photos are no longer saved to disk. Buffer goes straight to Cloudinary.
// This eliminates ephemeral-disk dependency on Railway.
const multer = require('multer');
const ALLOWED_PHOTO_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const photoUpload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    ALLOWED_PHOTO_TYPES.has(file.mimetype)
      ? cb(null, true)
      : cb(new Error('Only JPEG, PNG or WebP photos are allowed.'), false);
  },
});

// ── Token TTLs ────────────────────────────────────────────────────────────────
const EMAIL_VERIFY_TTL_MS  = 24 * 60 * 60 * 1000;  // 24 hours
const PASSWORD_RESET_TTL_MS =      60 * 60 * 1000;  //  1 hour

// ── Lockout helpers ───────────────────────────────────────────────────────────
async function checkAndHandleLockout(user) {
  if (!user) return { locked: false };
  const now = new Date();
  if (user.lockout_until && new Date(user.lockout_until) < now) {
    await pool.query(
      `UPDATE users SET failed_attempts = 0, lockout_until = NULL WHERE id = $1`,
      [user.id]
    );
    return { locked: false };
  }
  if (user.lockout_until && new Date(user.lockout_until) > now) {
    return { locked: true, retryAfterMs: new Date(user.lockout_until) - now };
  }
  return { locked: false };
}

async function recordFailedAttempt(user) {
  if (!user) return;
  const newCount   = (user.failed_attempts || 0) + 1;
  if (newCount >= lockoutCfg.maxFailedAttempts) {
    const multiplier  = Math.pow(2, newCount - lockoutCfg.maxFailedAttempts);
    const durationMs  = Math.min(lockoutCfg.backoffBaseMs * multiplier * 1000, lockoutCfg.durationMs);
    const lockoutUntil = new Date(Date.now() + durationMs);
    await pool.query(
      `UPDATE users SET failed_attempts = $1, lockout_until = $2 WHERE id = $3`,
      [newCount, lockoutUntil, user.id]
    );
    await log({ userId: user.id, action: ACTIONS.ACCOUNT_LOCKED, ipAddress: user._ip || null });
  } else {
    await pool.query(
      `UPDATE users SET failed_attempts = $1 WHERE id = $2`, [newCount, user.id]
    );
  }
}

async function clearFailedAttempts(userId) {
  await pool.query(
    `UPDATE users SET failed_attempts = 0, lockout_until = NULL WHERE id = $1`, [userId]
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/auth/signup
// Phase 2: generates a verification token, stores its SHA-256 hash in DB,
// and emails a one-time link to the user. Account is created immediately but
// upload/sign actions are blocked until email_verified = TRUE.
// ─────────────────────────────────────────────────────────────────────────────
router.post('/signup', authLimiter, validate('signup'), async (req, res) => {
  const { email, password } = req.body;
  try {
    const existing = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: 'Email already exists.' });
    }

    const password_hash = await bcrypt.hash(password, pwCfg.bcryptRounds);

    // Generate a raw 32-byte verification token; store only its SHA-256 hash.
    const rawToken   = crypto.randomBytes(32).toString('hex');  // 64 hex chars
    const tokenHash  = hashToken(rawToken);
    const sentAt     = new Date();

    const result = await pool.query(
      `INSERT INTO users
         (email, password_hash, email_verified, email_verification_token, email_verification_sent_at)
       VALUES ($1, $2, FALSE, $3, $4)
       RETURNING id, email, created_at`,
      [email, password_hash, tokenHash, sentAt]
    );
    const user = result.rows[0];

    await log({
      userId: user.id, action: ACTIONS.SIGNUP,
      deviceInfo: req.headers['user-agent'], ipAddress: req.ip,
    });

    // Build the verification link — token delivered in query string here
    // (unlike signing links, this goes to /api not /sign, is one-time use,
    // and the browser navigates to it directly, so query string is acceptable).
    const BASE_URL   = process.env.BASE_URL || 'http://localhost:3000';
    const verifyLink = `${BASE_URL}/verify-email?token=${rawToken}`;

    try {
      await sendVerificationEmail(email, verifyLink);
      await log({ userId: user.id, action: ACTIONS.EMAIL_VERIFICATION_SENT, ipAddress: req.ip });
    } catch (emailErr) {
      // Non-fatal: account is created; user can resend from login page.
      console.error('[auth] Verification email failed:', emailErr.message);
    }

    // Issue tokens so the user is "logged in" immediately — they can explore
    // the app but upload/sign are blocked until verified.
    const accessToken = issueAccessToken(user);
    await issueRefreshToken(user, res);

    return res.status(201).json({
      message:        'Account created. Please check your email to verify your address.',
      email_verified: false,
      token:          accessToken,
      user:           { id: user.id, email: user.email },
    });
  } catch (err) {
    console.error('Signup error:', err.message);
    return res.status(500).json({ error: 'Server error during signup.' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/auth/verify-email?token=RAW_HEX_TOKEN
// One-time link from email. Marks the account verified and clears the token.
// ─────────────────────────────────────────────────────────────────────────────
router.get('/verify-email', validate('verifyEmailQuery') && ((req, res, next) => {
  // validate() works on req.body; for query params we validate inline.
  next();
}), async (req, res) => {
  const rawToken = req.query.token;

  // Validate format before hitting DB
  if (!rawToken || !/^[a-f0-9]{64}$/.test(rawToken)) {
    return res.status(400).json({ error: 'Invalid verification token.' });
  }

  try {
    const tokenHash = hashToken(rawToken);

    const result = await pool.query(
      `SELECT id, email, email_verified, email_verification_sent_at
       FROM users
       WHERE email_verification_token = $1`,
      [tokenHash]
    );

    if (!result.rows[0]) {
      return res.status(404).json({
        error: 'Invalid or already-used verification link.',
        code:  'TOKEN_INVALID',
      });
    }

    const user = result.rows[0];

    if (user.email_verified) {
      return res.json({ message: 'Email already verified. You can sign in.' });
    }

    // Check TTL
    const sentAt = new Date(user.email_verification_sent_at);
    if (Date.now() - sentAt.getTime() > EMAIL_VERIFY_TTL_MS) {
      return res.status(410).json({
        error: 'Verification link has expired. Please request a new one.',
        code:  'TOKEN_EXPIRED',
      });
    }

    // Mark verified, clear token (one-time use)
    await pool.query(
      `UPDATE users
       SET email_verified = TRUE,
           email_verification_token   = NULL,
           email_verification_sent_at = NULL
       WHERE id = $1`,
      [user.id]
    );

    await log({ userId: user.id, action: ACTIONS.EMAIL_VERIFIED, ipAddress: req.ip });

    return res.json({ message: 'Email verified successfully. You can now sign documents.' });
  } catch (err) {
    console.error('Verify email error:', err.message);
    return res.status(500).json({ error: 'Verification failed.' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/auth/resend-verification
// Allows a logged-in OR logged-out user to request a fresh verification email.
// Rate-limited by authLimiter (same as login) to prevent abuse.
// ─────────────────────────────────────────────────────────────────────────────
router.post('/resend-verification', authLimiter, validate('resendVerification'), async (req, res) => {
  const { email } = req.body;

  // Always return 200 regardless of whether the email exists — prevents
  // user enumeration.
  const GENERIC_OK = { message: 'If that address has an unverified account, a new link has been sent.' };

  try {
    const result = await pool.query(
      'SELECT id, email, email_verified FROM users WHERE email = $1', [email]
    );
    const user = result.rows[0];

    if (!user || user.email_verified) {
      return res.json(GENERIC_OK);
    }

    const rawToken  = crypto.randomBytes(32).toString('hex');
    const tokenHash = hashToken(rawToken);
    const sentAt    = new Date();

    await pool.query(
      `UPDATE users
       SET email_verification_token = $1, email_verification_sent_at = $2
       WHERE id = $3`,
      [tokenHash, sentAt, user.id]
    );

    const BASE_URL   = process.env.BASE_URL || 'http://localhost:3000';
    const verifyLink = `${BASE_URL}/verify-email?token=${rawToken}`;

    try {
      await sendVerificationEmail(user.email, verifyLink);
      await log({ userId: user.id, action: ACTIONS.EMAIL_RESENT, ipAddress: req.ip });
    } catch (emailErr) {
      console.error('[auth] Resend verification email failed:', emailErr.message);
    }

    return res.json(GENERIC_OK);
  } catch (err) {
    console.error('Resend verification error:', err.message);
    return res.status(500).json({ error: 'Could not resend verification email.' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/auth/forgot-password
// Issues a time-limited (1h) single-use reset token. Always returns 200 to
// prevent user enumeration.
// ─────────────────────────────────────────────────────────────────────────────
router.post('/forgot-password', authLimiter, validate('forgotPassword'), async (req, res) => {
  const { email } = req.body;

  const GENERIC_OK = { message: 'If that email address has an account, a password reset link has been sent.' };

  try {
    const result = await pool.query(
      'SELECT id, email FROM users WHERE email = $1', [email]
    );
    const user = result.rows[0];

    if (!user) return res.json(GENERIC_OK);

    const rawToken  = crypto.randomBytes(32).toString('hex');  // 64 hex chars
    const tokenHash = hashToken(rawToken);
    const expiresAt = new Date(Date.now() + PASSWORD_RESET_TTL_MS);

    await pool.query(
      `UPDATE users
       SET password_reset_token = $1, password_reset_expires_at = $2
       WHERE id = $3`,
      [tokenHash, expiresAt, user.id]
    );

    const BASE_URL  = process.env.BASE_URL || 'http://localhost:3000';
    const resetLink = `${BASE_URL}/reset-password?token=${rawToken}`;

    try {
      await sendPasswordResetEmail(user.email, resetLink);
      await log({ userId: user.id, action: ACTIONS.PASSWORD_RESET_REQUESTED, ipAddress: req.ip });
    } catch (emailErr) {
      console.error('[auth] Password reset email failed:', emailErr.message);
    }

    return res.json(GENERIC_OK);
  } catch (err) {
    console.error('Forgot password error:', err.message);
    return res.status(500).json({ error: 'Could not process request.' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/auth/reset-password
// Validates the token and sets a new password. Token is single-use — cleared
// after successful use.
// ─────────────────────────────────────────────────────────────────────────────
router.post('/reset-password', authLimiter, validate('resetPassword'), async (req, res) => {
  const { token: rawToken, password } = req.body;

  try {
    const tokenHash = hashToken(rawToken);

    const result = await pool.query(
      `SELECT id, email, password_reset_expires_at
       FROM users
       WHERE password_reset_token = $1`,
      [tokenHash]
    );

    if (!result.rows[0]) {
      return res.status(404).json({
        error: 'Invalid or already-used reset link.',
        code:  'TOKEN_INVALID',
      });
    }

    const user = result.rows[0];

    if (new Date() > new Date(user.password_reset_expires_at)) {
      // Clear the expired token
      await pool.query(
        `UPDATE users SET password_reset_token = NULL, password_reset_expires_at = NULL WHERE id = $1`,
        [user.id]
      );
      return res.status(410).json({
        error: 'Reset link has expired. Please request a new one.',
        code:  'TOKEN_EXPIRED',
      });
    }

    const password_hash = await bcrypt.hash(password, pwCfg.bcryptRounds);

    // Update password, clear reset token, clear any active lockout
    await pool.query(
      `UPDATE users
       SET password_hash             = $1,
           password_reset_token      = NULL,
           password_reset_expires_at = NULL,
           failed_attempts           = 0,
           lockout_until             = NULL
       WHERE id = $2`,
      [password_hash, user.id]
    );

    // Revoke all existing refresh tokens — forces re-login everywhere
    await pool.query(
      `UPDATE refresh_tokens SET revoked = TRUE WHERE user_id = $1`,
      [user.id]
    );

    await log({ userId: user.id, action: ACTIONS.PASSWORD_RESET_COMPLETE, ipAddress: req.ip });

    return res.json({ message: 'Password updated successfully. Please log in with your new password.' });
  } catch (err) {
    console.error('Reset password error:', err.message);
    return res.status(500).json({ error: 'Could not reset password.' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/auth/login
// ─────────────────────────────────────────────────────────────────────────────
router.post('/login', authLimiter, validate('login'), async (req, res) => {
  const { email, password } = req.body;
  try {
    const result  = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    const user    = result.rows[0];
    const DUMMY   = '$2a$12$invalidhashvaluethatnevermatchesXXXXXXXXXXXXXXXXXXXXXX';
    const isMatch = await bcrypt.compare(password, user?.password_hash || DUMMY);
    if (user) user._ip = req.ip;

    const lockout = await checkAndHandleLockout(user);
    if (lockout.locked) {
      return res.status(423).json({
        error:      `Account temporarily locked. Try again in ${Math.ceil(lockout.retryAfterMs / 1000)} seconds.`,
        retryAfter: Math.ceil(lockout.retryAfterMs / 1000),
      });
    }

    if (!user || !isMatch) {
      await recordFailedAttempt(user);
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    await clearFailedAttempts(user.id);
    await log({ userId: user.id, action: ACTIONS.LOGIN, deviceInfo: req.headers['user-agent'], ipAddress: req.ip });

    if (user.mfa_enabled) {
      const preMfaToken = issueAccessToken({ ...user, mfa_verified: false });
      return res.json({
        mfa_required:   true,
        email_verified: user.email_verified,
        token:          preMfaToken,
        user:           { id: user.id, email: user.email },
      });
    }

    const accessToken = issueAccessToken({ ...user, mfa_verified: false });
    await issueRefreshToken(user, res);
    return res.json({
      message:        'Login successful.',
      email_verified: user.email_verified,
      token:          accessToken,
      user:           { id: user.id, email: user.email, profile_photo: user.profile_photo },
    });
  } catch (err) {
    console.error('Login error:', err.message);
    return res.status(500).json({ error: 'Server error during login.' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/auth/refresh
// ─────────────────────────────────────────────────────────────────────────────
router.post('/refresh', authLimiter, async (req, res) => {
  try {
    const rawToken = req.cookies?.[cookieCfg.name];
    const { accessToken, user } = await rotateRefreshToken(rawToken, res);
    return res.json({ token: accessToken, user: { id: user.id, email: user.email } });
  } catch (err) {
    return res.status(err.status || 401).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/auth/logout
// ─────────────────────────────────────────────────────────────────────────────
router.post('/logout', async (req, res) => {
  try {
    const rawToken = req.cookies?.[cookieCfg.name];
    await revokeRefreshToken(rawToken, res);
    const authHeader = req.headers['authorization'];
    if (authHeader?.startsWith('Bearer ')) {
      try {
        const { verifyAccessToken } = require('../services/tokenService');
        const decoded = verifyAccessToken(authHeader.slice(7));
        await log({ userId: decoded.id, action: ACTIONS.LOGOUT, ipAddress: req.ip });
      } catch (_) {}
    }
    return res.json({ message: 'Logged out successfully.' });
  } catch (err) {
    return res.status(500).json({ error: 'Logout failed.' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/auth/logout-all
// ─────────────────────────────────────────────────────────────────────────────
router.post('/logout-all', authMiddleware, async (req, res) => {
  try {
    await revokeAllUserTokens(req.user.id, res);
    await log({ userId: req.user.id, action: ACTIONS.LOGOUT_ALL, ipAddress: req.ip });
    return res.json({ message: 'All sessions invalidated.' });
  } catch (err) {
    return res.status(500).json({ error: 'Could not invalidate sessions.' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/auth/me
// ─────────────────────────────────────────────────────────────────────────────
router.get('/me', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, email, created_at, profile_photo, mfa_enabled, email_verified FROM users WHERE id = $1`,
      [req.user.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'User not found.' });
    return res.json({ user: result.rows[0] });
  } catch (err) {
    return res.status(500).json({ error: 'Could not fetch user.' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// MFA routes — secrets encrypted with AES-256-GCM before DB storage
// ─────────────────────────────────────────────────────────────────────────────

router.get('/mfa/setup', authMiddleware, async (req, res) => {
  try {
    const userResult = await pool.query(
      'SELECT email, mfa_enabled FROM users WHERE id = $1', [req.user.id]
    );
    const user = userResult.rows[0];
    if (!user)          return res.status(404).json({ error: 'User not found.' });
    if (user.mfa_enabled) return res.status(400).json({ error: 'MFA already enabled.' });

    const secret       = authenticator.generateSecret();
    const otpauthUrl   = authenticator.keyuri(user.email, mfaCfg.issuer, secret);
    const qrDataUrl    = await qrcode.toDataURL(otpauthUrl);

    const encryptedPending = encrypt(secret);
    await pool.query(
      `UPDATE users SET mfa_secret_pending = $1 WHERE id = $2`,
      [encryptedPending, req.user.id]
    );

    return res.json({ secret, qr: qrDataUrl });
  } catch (err) {
    console.error('MFA setup error:', err.message);
    return res.status(500).json({ error: 'Could not generate MFA setup.' });
  }
});

router.post('/mfa/verify', authMiddleware, validate('verifyMfa'), async (req, res) => {
  const { token } = req.body;
  try {
    const userResult = await pool.query(
      'SELECT mfa_secret_pending, mfa_enabled FROM users WHERE id = $1', [req.user.id]
    );
    const user = userResult.rows[0];
    if (!user?.mfa_secret_pending) {
      return res.status(400).json({ error: 'No pending MFA setup. Call /mfa/setup first.' });
    }
    if (user.mfa_enabled) return res.status(400).json({ error: 'MFA already enabled.' });

    const secret = decrypt(user.mfa_secret_pending);
    const valid  = authenticator.verify({ token, secret });
    if (!valid) return res.status(400).json({ error: 'Invalid TOTP code. Try again.' });

    await pool.query(
      `UPDATE users SET mfa_enabled = TRUE, mfa_secret = mfa_secret_pending,
       mfa_secret_pending = NULL WHERE id = $1`,
      [req.user.id]
    );

    await log({ userId: req.user.id, action: ACTIONS.MFA_ENABLED, ipAddress: req.ip });

    const accessToken = issueAccessToken({ id: req.user.id, email: req.user.email, mfa_verified: true });
    await issueRefreshToken({ id: req.user.id, email: req.user.email }, res);
    return res.json({ message: 'MFA enabled.', token: accessToken });
  } catch (err) {
    console.error('MFA verify error:', err.message);
    return res.status(500).json({ error: 'Could not enable MFA.' });
  }
});

router.post('/mfa/authenticate', authMiddleware, authLimiter, validate('verifyMfa'), async (req, res) => {
  const { token } = req.body;
  try {
    const userResult = await pool.query(
      'SELECT id, email, mfa_secret, mfa_enabled, profile_photo FROM users WHERE id = $1',
      [req.user.id]
    );
    const user = userResult.rows[0];
    if (!user?.mfa_enabled || !user.mfa_secret) {
      return res.status(400).json({ error: 'MFA not enabled.' });
    }

    const secret = decrypt(user.mfa_secret);
    const valid  = authenticator.verify({ token, secret });
    if (!valid) {
      await recordFailedAttempt({ ...user, _ip: req.ip });
      return res.status(401).json({ error: 'Invalid TOTP code.' });
    }

    await clearFailedAttempts(user.id);
    const accessToken = issueAccessToken({ id: user.id, email: user.email, mfa_verified: true });
    await issueRefreshToken(user, res);
    await log({ userId: user.id, action: ACTIONS.MFA_AUTH, ipAddress: req.ip });
    return res.json({
      message: 'MFA authentication successful.',
      token:   accessToken,
      user:    { id: user.id, email: user.email, profile_photo: user.profile_photo },
    });
  } catch (err) {
    console.error('MFA authenticate error:', err.message);
    return res.status(500).json({ error: 'MFA authentication failed.' });
  }
});

router.post('/mfa/disable', authMiddleware, validate('disableMfa'), async (req, res) => {
  const { token, password } = req.body;
  try {
    const userResult = await pool.query('SELECT * FROM users WHERE id = $1', [req.user.id]);
    const user = userResult.rows[0];
    if (!user?.mfa_enabled) return res.status(400).json({ error: 'MFA not enabled.' });

    const pwMatch = await bcrypt.compare(password, user.password_hash);
    if (!pwMatch) return res.status(401).json({ error: 'Incorrect password.' });

    const secret     = decrypt(user.mfa_secret);
    const totpValid  = authenticator.verify({ token, secret });
    if (!totpValid) return res.status(401).json({ error: 'Invalid TOTP code.' });

    await pool.query(
      `UPDATE users SET mfa_enabled = FALSE, mfa_secret = NULL,
       mfa_secret_pending = NULL WHERE id = $1`,
      [req.user.id]
    );
    await log({ userId: req.user.id, action: ACTIONS.MFA_DISABLED, ipAddress: req.ip });
    return res.json({ message: 'MFA disabled.' });
  } catch (err) {
    console.error('MFA disable error:', err.message);
    return res.status(500).json({ error: 'Could not disable MFA.' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/auth/profile-photo — upload to Cloudinary (Fix 4)
// ─────────────────────────────────────────────────────────────────────────────
router.post('/profile-photo', authMiddleware, photoUpload.single('photo'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No photo uploaded.' });

    // Upload buffer directly to Cloudinary — no local disk involved
    const publicId = `photo-${uuidv4()}`;
    let uploaded;
    try {
      uploaded = await uploadPhoto(req.file.buffer, publicId);
    } catch (uploadErr) {
      console.error('Photo Cloudinary upload error:', uploadErr.message);
      return res.status(502).json({ error: 'Photo storage failed. Please try again.' });
    }

    // Delete old photo from Cloudinary (handles both URL and legacy filename)
    const existing = await pool.query('SELECT profile_photo FROM users WHERE id = $1', [req.user.id]);
    const oldStored = existing.rows[0]?.profile_photo;
    if (oldStored) {
      if (oldStored.startsWith('http')) {
        await deletePhoto(oldStored);          // new Cloudinary URL
      } else {
        // Legacy local filename — file may be gone after Railway restart,
        // best-effort only
        const { safeDelete } = require('../services/fileService');
        safeDelete(oldStored);
      }
    }

    // Store Cloudinary URL in DB (replaces old filename approach)
    await pool.query('UPDATE users SET profile_photo = $1 WHERE id = $2', [uploaded.url, req.user.id]);
    return res.json({ profile_photo: uploaded.url });
  } catch (err) {
    console.error('Photo upload error:', err.message);
    return res.status(500).json({ error: 'Could not upload photo.' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/auth/photo/:filename — serve authenticated profile photo
// New photos: profile_photo = Cloudinary URL → redirect to it.
// Legacy photos: profile_photo = local filename → stream from disk.
// Only the requesting user's own photo is served (ownership enforced by DB lookup).
// ─────────────────────────────────────────────────────────────────────────────
router.get('/photo/:filename', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT profile_photo FROM users WHERE id = $1',
      [req.user.id]
    );
    const stored = result.rows[0]?.profile_photo;
    if (!stored) return res.status(404).json({ error: 'No profile photo.' });

    // New: Cloudinary URL stored directly → redirect to it
    if (stored.startsWith('http')) {
      return res.redirect(302, stored);
    }

    // Legacy: local filename stored → verify match and stream from disk
    const storedBasename = path.basename(stored);
    if (storedBasename !== req.params.filename) {
      return res.status(404).json({ error: 'Not found.' });
    }

    const { streamFileToResponse } = require('../services/fileService');
    const served = streamFileToResponse(res, storedBasename, storedBasename);
    if (!served) return res.status(404).json({ error: 'Photo file not found.' });
  } catch (err) {
    console.error('Photo serve error:', err.message);
    return res.status(500).json({ error: 'Could not serve photo.' });
  }
});

module.exports = router;

// GET /api/auth/profile-photo — serve authenticated user profile photo
router.get('/profile-photo', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT profile_photo FROM users WHERE id = $1', [req.user.id]
    );
    const filename = result.rows[0]?.profile_photo;
    if (!filename) return res.status(404).json({ error: 'No profile photo.' });
    const { streamFileToResponse } = require('../services/fileService');
    const served = streamFileToResponse(res, filename, filename);
    if (!served) return res.status(404).json({ error: 'Photo file not found.' });
  } catch (err) {
    console.error('Photo serve error:', err.message);
    return res.status(500).json({ error: 'Could not serve photo.' });
  }
});
