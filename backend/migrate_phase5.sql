-- ============================================================================
-- Phase 5 migration — Audit & Integrity System
-- Run AFTER migrate_phase4.sql
-- BACKUP: pg_dump -U milton -d securesign > backup_before_phase5.sql
-- ============================================================================

BEGIN;

-- ── 1. audit_logs — add metadata and row_hmac columns ────────────────────────
ALTER TABLE audit_logs
  ADD COLUMN IF NOT EXISTS metadata  JSONB,
  ADD COLUMN IF NOT EXISTS row_hmac  VARCHAR(64);

-- ── 2. documents — recipient token expiry and one-time use ───────────────────
ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS recipient_token_expires_at TIMESTAMP WITH TIME ZONE,
  ADD COLUMN IF NOT EXISTS recipient_token_used       BOOLEAN NOT NULL DEFAULT FALSE;

-- ── 3. Append-only trigger on audit_logs ─────────────────────────────────────
-- Prevents any UPDATE or DELETE on audit_logs, even by the app DB user.
-- Only INSERT is allowed — enforces immutability at DB level.
CREATE OR REPLACE FUNCTION audit_logs_immutable()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'audit_logs is append-only. UPDATE and DELETE are not permitted.';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_audit_logs_immutable ON audit_logs;
CREATE TRIGGER trg_audit_logs_immutable
  BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION audit_logs_immutable();

-- ── 4. Indexes ────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_audit_action
  ON audit_logs(action);
CREATE INDEX IF NOT EXISTS idx_audit_timestamp
  ON audit_logs(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_documents_token_expiry
  ON documents(recipient_token_expires_at)
  WHERE recipient_token_expires_at IS NOT NULL;

-- ── 5. orig_file_path (if not already added in Phase 4 hotfix) ───────────────
ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS orig_file_path VARCHAR(500);

COMMIT;

-- Verify
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name = 'audit_logs'
ORDER BY ordinal_position;
