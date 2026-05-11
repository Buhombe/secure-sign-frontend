-- ============================================================================
-- Phase 4 migration — Cryptographic Signing
-- Run AFTER migrate_phase3.sql
-- BACKUP: pg_dump -U milton -d securesign > backup_before_phase4.sql
-- ============================================================================

BEGIN;

-- ── 1. users — RSA key pair storage ──────────────────────────────────────────
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS public_key      TEXT,   -- PEM, plaintext (public)
  ADD COLUMN IF NOT EXISTS private_key_enc TEXT;   -- AES-256-GCM encrypted PEM

-- ── 2. signatures — cryptographic fields ─────────────────────────────────────
ALTER TABLE signatures
  -- RSA-PSS signature over the original PDF bytes (hex string)
  ADD COLUMN IF NOT EXISTS crypto_signature TEXT,
  -- SHA-256 of PDF bytes at signing time (hex string)
  ADD COLUMN IF NOT EXISTS document_hash   VARCHAR(64);

-- ── 3. Index on document_hash for fast tamper detection queries ───────────────
CREATE INDEX IF NOT EXISTS idx_signatures_document_hash
  ON signatures(document_hash);

-- ── 4. Index on signer for audit queries ─────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_signatures_signer
  ON signatures(signer_email);

COMMIT;

-- Verify
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name = 'signatures'
ORDER BY ordinal_position;
