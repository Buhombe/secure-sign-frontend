-- ============================================================================
-- Phase 6 migration — Launch Upgrade
-- Adds: soft delete, signed_by email on documents, cloudinary_public_id column
-- Run AFTER migrate_phase5.sql
-- BACKUP: pg_dump -U <user> -d <db> > backup_before_phase6.sql
-- ============================================================================

BEGIN;

-- ── 1. Soft delete on documents ───────────────────────────────────────────────
-- Replaces hard DELETE operations. Documents are never physically removed.
ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS is_deleted BOOLEAN NOT NULL DEFAULT FALSE;

-- Index for fast filtering of non-deleted documents
CREATE INDEX IF NOT EXISTS idx_documents_not_deleted
  ON documents(user_id)
  WHERE is_deleted = FALSE;

-- ── 2. Cloudinary storage fields ──────────────────────────────────────────────
-- Stores the Cloudinary public ID alongside the secure URL.
-- file_path will now hold the Cloudinary secure URL (https://res.cloudinary.com/...)
-- cloudinary_public_id allows deletion/overwrite via Cloudinary API.
ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS cloudinary_public_id VARCHAR(500);

-- orig_cloudinary_public_id for the original PDF before signing
ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS orig_cloudinary_public_id VARCHAR(500);

-- ── 3. Signing metadata on documents ─────────────────────────────────────────
-- signed_at and signed_by are convenience columns at the document level.
-- The canonical record is still in the signatures table.
ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS signed_at  TIMESTAMP WITH TIME ZONE,
  ADD COLUMN IF NOT EXISTS signed_by  VARCHAR(254);

-- ── 4. Remove foreign key CASCADE DELETE from documents → users ───────────────
-- Phase 5 (Backup Awareness): prevent cascading deletes from destroying documents.
-- We keep ON DELETE SET NULL on audit_logs (already set) and replace
-- ON DELETE CASCADE on documents with ON DELETE RESTRICT so user deletion
-- must be explicit.
--
-- NOTE: This requires no existing document rows to reference a deleted user.
-- Run only if you want this level of protection (recommended for production).
-- If you have existing FK constraints named differently, adjust the constraint
-- names below to match your schema.
--
-- To find existing FK names:
--   SELECT conname FROM pg_constraint WHERE conrelid = 'documents'::regclass AND contype = 'f';
--
-- Uncomment these lines when you are ready:
-- ALTER TABLE documents DROP CONSTRAINT IF EXISTS documents_user_id_fkey;
-- ALTER TABLE documents ADD CONSTRAINT documents_user_id_fkey
--   FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE RESTRICT;

-- ── 5. Indexes ────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_documents_signed_at
  ON documents(signed_at DESC)
  WHERE signed_at IS NOT NULL;

COMMIT;

-- Verify
SELECT column_name, data_type, column_default
FROM information_schema.columns
WHERE table_name = 'documents'
ORDER BY ordinal_position;
