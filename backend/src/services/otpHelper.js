'use strict';

/**
 * otpHelper.js — FIX P9
 *
 * Generates, hashes, and verifies SMS/WhatsApp OTP codes.
 *
 * OTPs are NEVER stored in plaintext. We store HMAC-SHA256(otp, AUDIT_HMAC_KEY).
 * Verification is done with timing-safe comparison.
 *
 * Why HMAC and not bcrypt?
 *   - OTPs are short-lived (10 min) and low-entropy (6 digits) — bcrypt is overkill
 *     and slow. The rate-limit on otp_attempts (max 3) prevents brute force.
 *   - HMAC with a server secret is equivalent security for this use case.
 *   - bcrypt would work too — use it if you remove the attempts limit.
 */

const crypto = require('crypto');

function getHmacKey() {
  const key = process.env.AUDIT_HMAC_KEY;
  if (!key || key.length < 32) throw new Error('AUDIT_HMAC_KEY not set or too short.');
  return key;
}

/**
 * Generates a 6-digit numeric OTP.
 * Uses crypto.randomInt for uniform distribution (no modulo bias).
 */
function generateOtp() {
  return String(crypto.randomInt(100000, 999999));
}

/**
 * Hashes an OTP for safe DB storage.
 * Returns a 64-char hex string.
 */
function hashOtp(rawOtp) {
  return crypto
    .createHmac('sha256', getHmacKey())
    .update(String(rawOtp))
    .digest('hex');
}

/**
 * Timing-safe comparison of a candidate OTP against its stored hash.
 * Returns true if they match.
 */
function verifyOtp(candidateOtp, storedHash) {
  if (!candidateOtp || !storedHash) return false;
  const candidateHash = hashOtp(candidateOtp);

  const a = Buffer.from(candidateHash, 'hex');
  const b = Buffer.from(storedHash,   'hex');

  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

module.exports = { generateOtp, hashOtp, verifyOtp };
