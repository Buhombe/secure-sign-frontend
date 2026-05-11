'use strict';

/**
 * encryptionService.js
 *
 * AES-256-GCM authenticated encryption for sensitive fields stored in the DB.
 *
 * Used for:
 *   - mfa_secret (TOTP seeds) — Phase 3
 *   - Any future PII fields
 *
 * Format of encrypted output (stored as a single string in the DB):
 *   <version>:<iv_hex>:<authTag_hex>:<ciphertext_hex>
 *
 *   version    — "v1" — allows future algorithm rotation without data loss
 *   iv         — 12 random bytes (96 bits) — required for GCM, never reused
 *   authTag    — 16 bytes — GCM authentication tag, detects tampering
 *   ciphertext — encrypted data bytes
 *
 * Why AES-256-GCM:
 *   - Authenticated encryption: decryption fails if ciphertext was tampered with
 *   - NIST-recommended, widely audited
 *   - No padding oracle attacks (unlike AES-CBC)
 *   - Fast in hardware (AES-NI)
 *
 * Key management:
 *   - Key is read from FIELD_ENCRYPTION_KEY env var (64 hex chars = 32 bytes)
 *   - Rotate key: re-encrypt all rows with new key, then swap env var
 *   - Never log or expose the key
 */

const crypto = require('crypto');

const ALGORITHM    = 'aes-256-gcm';
const IV_BYTES     = 12;    // 96-bit IV — recommended for GCM
const TAG_BYTES    = 16;    // 128-bit auth tag
const VERSION      = 'v1';

// ── Key loading — fail fast at module load time ───────────────────────────────
function loadKey() {
  const hexKey = process.env.FIELD_ENCRYPTION_KEY;
  if (!hexKey) {
    throw new Error('FATAL: FIELD_ENCRYPTION_KEY environment variable is not set.');
  }
  if (hexKey.length !== 64) {
    throw new Error('FATAL: FIELD_ENCRYPTION_KEY must be exactly 64 hex characters (32 bytes).');
  }
  const key = Buffer.from(hexKey, 'hex');
  if (key.length !== 32) {
    throw new Error('FATAL: FIELD_ENCRYPTION_KEY decoded to wrong length.');
  }
  return key;
}

// Lazy-load so tests can set the env var before requiring this module
let _key = null;
function getKey() {
  if (!_key) _key = loadKey();
  return _key;
}

// ── encrypt(plaintext) → string ──────────────────────────────────────────────
/**
 * Encrypts a plaintext string.
 * Returns a versioned colon-delimited string safe for VARCHAR storage.
 */
function encrypt(plaintext) {
  if (plaintext === null || plaintext === undefined) return null;

  const key        = getKey();
  const iv         = crypto.randomBytes(IV_BYTES);
  const cipher     = crypto.createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
  const encrypted  = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag    = cipher.getAuthTag();

  return `${VERSION}:${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
}

// ── decrypt(stored) → string ─────────────────────────────────────────────────
/**
 * Decrypts a value produced by encrypt().
 * Throws if the ciphertext was tampered with (GCM authentication failure).
 */
function decrypt(stored) {
  if (stored === null || stored === undefined) return null;

  const parts = stored.split(':');
  if (parts.length !== 4) {
    throw new Error('Invalid encrypted field format.');
  }

  const [version, ivHex, tagHex, ctHex] = parts;
  if (version !== VERSION) {
    throw new Error(`Unsupported encryption version: ${version}`);
  }

  const key        = getKey();
  const iv         = Buffer.from(ivHex, 'hex');
  const authTag    = Buffer.from(tagHex, 'hex');
  const ciphertext = Buffer.from(ctHex, 'hex');

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
  decipher.setAuthTag(authTag);

  try {
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch (err) {
    // GCM auth failure — ciphertext was tampered with or wrong key
    throw new Error('Decryption failed: authentication tag mismatch.');
  }
}

// ── isEncrypted(value) → boolean ─────────────────────────────────────────────
/**
 * Heuristic check — true if the value looks like our encrypted format.
 * Useful for migrating plaintext legacy rows.
 */
function isEncrypted(value) {
  if (typeof value !== 'string') return false;
  const parts = value.split(':');
  return parts.length === 4 && parts[0] === VERSION;
}

// ── hashToken(raw) → string ──────────────────────────────────────────────────
/**
 * One-way SHA-256 hash for tokens that never need to be decrypted
 * (recipient_token, etc.). Same pattern as refresh token storage.
 */
function hashToken(raw) {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

module.exports = { encrypt, decrypt, isEncrypted, hashToken };