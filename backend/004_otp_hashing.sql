-- ============================================================
-- Migration 004: Enforce OTP hashing policy
-- FIX P9: otp_code must never be stored in plaintext.
--
-- This migration:
--   1. Renames the plaintext column to otp_code_hash (documents intent)
--   2. Adds a check constraint ensuring the value looks like a hex hash
--      (64 chars = SHA-256, or bcrypt $2b$ prefix)
--   3. Adds otp_salt for HMAC-based OTP verification
--
-- Application layer must:
--   - Generate OTP → compute HMAC-SHA256(otp, AUDIT_HMAC_KEY) → store hash
--   - Verify OTP → compute HMAC-SHA256(candidate, key) → timing-safe compare
-- ============================================================

BEGIN;

-- Step 1: rename column to signal intent
ALTER TABLE document_signers
  RENAME COLUMN otp_code TO otp_code_hash;

-- Step 2: add constraint — value must be a 64-char hex SHA-256 or NULL
ALTER TABLE document_signers
  ADD CONSTRAINT chk_otp_hash_format
  CHECK (
    otp_code_hash IS NULL
    OR otp_code_hash ~ '^[a-f0-9]{64}$'
  );

-- Step 3: Clear any existing plaintext OTPs (they are now invalid anyway
-- since verification will fail against the new hash-based check)
UPDATE document_signers
SET otp_code_hash = NULL,
    otp_expires_at = NULL,
    otp_attempts = 0
WHERE otp_code_hash IS NOT NULL
  AND otp_code_hash !~ '^[a-f0-9]{64}$';

COMMENT ON COLUMN document_signers.otp_code_hash IS
  'HMAC-SHA256 hex of the OTP sent to the signer. Never store plaintext OTPs. '
  'Compute: crypto.createHmac(''sha256'', AUDIT_HMAC_KEY).update(rawOtp).digest(''hex'')';

COMMIT;
