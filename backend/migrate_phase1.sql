-- ============================================================================
-- Phase 1 migration — run once against existing database
-- ============================================================================
-- BACKUP YOUR DATABASE BEFORE RUNNING THIS.
-- psql -U youruser -d yourdb -f migrate_phase1.sql
-- ============================================================================

BEGIN;

-- 1. Rename signature_image → signature_hash and change type/constraint
--    If the column doesn't exist under the old name, this is a no-op.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'signatures' AND column_name = 'signature_image'
  ) THEN
    -- Compute SHA-256 of existing base64 content and store as hex.
    -- For existing rows: hash the stored text bytes (best-effort migration).
    ALTER TABLE signatures ADD COLUMN IF NOT EXISTS signature_hash VARCHAR(64);
    UPDATE signatures
    SET signature_hash = encode(digest(signature_image::bytea, 'sha256'), 'hex')
    WHERE signature_hash IS NULL;
    ALTER TABLE signatures ALTER COLUMN signature_hash SET NOT NULL;
    ALTER TABLE signatures DROP COLUMN signature_image;
    RAISE NOTICE 'Migrated signature_image → signature_hash';
  ELSE
    RAISE NOTICE 'signature_image column not found — skipping (may already be migrated)';
  END IF;
END $$;

-- 2. Tighten document status to an enum-like CHECK constraint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.check_constraints
    WHERE constraint_name = 'documents_status_check'
  ) THEN
    ALTER TABLE documents
      ADD CONSTRAINT documents_status_check
      CHECK (status IN ('pending', 'signed', 'revoked'));
    RAISE NOTICE 'Added status CHECK constraint';
  END IF;
END $$;

-- 3. Add missing indexes
CREATE INDEX IF NOT EXISTS idx_documents_user_id   ON documents(user_id);
CREATE INDEX IF NOT EXISTS idx_signatures_document ON signatures(document_id);
CREATE INDEX IF NOT EXISTS idx_audit_user_id       ON audit_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_audit_document_id   ON audit_logs(document_id);

-- 4. Narrow varchar columns to match application-layer limits
ALTER TABLE users
  ALTER COLUMN email TYPE VARCHAR(254);

ALTER TABLE signatures
  ALTER COLUMN signer_email TYPE VARCHAR(254);

COMMIT;

-- Verify
SELECT column_name, data_type, character_maximum_length
FROM information_schema.columns
WHERE table_name = 'signatures'
ORDER BY ordinal_position;
