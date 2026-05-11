-- ============================================================================
-- Phase 3 migration — Data & File Security
-- Run AFTER migrate_phase2.sql
-- BACKUP first: pg_dump -U milton -d securesign > backup_before_phase3.sql
-- ============================================================================

BEGIN;

-- ── 1. documents table — add file_hash for integrity verification ─────────────
ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS file_hash VARCHAR(64);

-- ── 2. recipient_token — change to store SHA-256 hash ────────────────────────
-- Existing UUID tokens are migrated to their SHA-256 hash.
-- After migration, the raw token no longer exists anywhere — recipients
-- will need a new share link (acceptable for existing unsigned docs).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'documents' AND column_name = 'recipient_token'
  ) THEN
    -- Hash any existing plaintext UUID tokens
    UPDATE documents
    SET recipient_token = encode(
      digest(recipient_token::text, 'sha256'), 'hex'
    )
    WHERE recipient_token IS NOT NULL
      AND length(recipient_token) = 36;  -- UUID format = 36 chars
    RAISE NOTICE 'Hashed existing recipient_token values';
  END IF;
END $$;

-- ── 3. signatures — ensure signature_hash column exists (from Phase 1) ────────
ALTER TABLE signatures
  ADD COLUMN IF NOT EXISTS signature_hash VARCHAR(64);

-- Drop signature_image if it somehow still exists
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'signatures' AND column_name = 'signature_image'
  ) THEN
    ALTER TABLE signatures DROP COLUMN signature_image;
    RAISE NOTICE 'Dropped signature_image column';
  END IF;
END $$;

-- ── 4. Add index on file_hash for integrity lookup ────────────────────────────
CREATE INDEX IF NOT EXISTS idx_documents_file_hash ON documents(file_hash);

-- ── 5. Add index on recipient_token for public file access ───────────────────
CREATE INDEX IF NOT EXISTS idx_documents_recipient_token ON documents(recipient_token);

COMMIT;

-- Verify documents schema
SELECT column_name, data_type, character_maximum_length
FROM information_schema.columns
WHERE table_name = 'documents'
ORDER BY ordinal_position;
