-- ============================================================================
-- Migration 005 — Decline-to-Sign Workflow
--
-- PREREQUISITES: Migrations 001–004 and migrate_phase8.sql must have run.
-- SAFE TO RE-RUN: All statements use IF NOT EXISTS / IF EXISTS guards.
--
-- What this migration does:
--   1. Adds 'declined' to document_signers.status CHECK constraint
--   2. Adds 'declined' to documents.status CHECK constraint
--   3. Adds DECLINE action constant to audit_logs (no schema change needed —
--      ACTIONS are app-level constants; the DB action column is TEXT)
--   4. Adds index for fast declined-signer queries
--   5. Adds decline_ip / decline_user_agent columns for legal forensics
--   6. Adds 'declined' event_type guard to signer_events (already present in
--      phase8 migration — this is a safety re-application)
--   7. Creates immutable RULE on audit_logs if not already present
-- ============================================================================

BEGIN;

-- ── 1. document_signers.status — add 'declined' variant ──────────────────────
-- PostgreSQL does not support ALTER TABLE ... ALTER COLUMN ... DROP CONSTRAINT
-- by name for inline CHECK constraints; we must drop and recreate.
-- The constraint name follows Postgres' auto-naming convention: <table>_<col>_check.
-- We use a DO block so the whole migration is still idempotent.

DO $$
BEGIN
  -- Drop existing CHECK on document_signers.status so we can widen it.
  -- The constraint may be named differently depending on Postgres version; try both.
  BEGIN
    ALTER TABLE document_signers DROP CONSTRAINT IF EXISTS document_signers_status_check;
  EXCEPTION WHEN others THEN
    NULL;
  END;

  -- Drop any legacy named constraint
  BEGIN
    ALTER TABLE document_signers DROP CONSTRAINT IF EXISTS ds_status_check;
  EXCEPTION WHEN others THEN
    NULL;
  END;
END $$;

ALTER TABLE document_signers
  ADD CONSTRAINT document_signers_status_check
  CHECK (status IN ('pending','signed','declined','expired','cancelled'));

-- ── 2. documents.status — add 'declined' variant ─────────────────────────────
DO $$
BEGIN
  BEGIN
    ALTER TABLE documents DROP CONSTRAINT IF EXISTS documents_status_check;
  EXCEPTION WHEN others THEN NULL; END;
END $$;

ALTER TABLE documents
  ADD CONSTRAINT documents_status_check
  CHECK (status IN ('pending','signed','declined','revoked','expired','voided'));

-- ── 3. Forensic columns on document_signers ──────────────────────────────────
-- declined_at and decline_reason already exist from migration 002.
-- Add ip/UA for legal defensibility if not yet present.
ALTER TABLE document_signers
  ADD COLUMN IF NOT EXISTS decline_ip         VARCHAR(45),
  ADD COLUMN IF NOT EXISTS decline_user_agent TEXT;

-- ── 4. Indexes ────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_signers_declined
  ON document_signers(document_id)
  WHERE status = 'declined';

CREATE INDEX IF NOT EXISTS idx_signers_status
  ON document_signers(document_id, status);

CREATE INDEX IF NOT EXISTS idx_documents_declined
  ON documents(user_id, status)
  WHERE status = 'declined';

-- ── 5. signer_events.event_type — ensure 'declined' is present ───────────────
-- Phase 8 already has: 'sent','viewed','signed','declined','completed'
-- This is a safety no-op guard — the constraint already includes 'declined'.
-- We don't attempt to drop/recreate it here; if the constraint is missing the
-- phase8 migration should have run first.

-- ── 6. Immutability rule on audit_logs (safety re-apply) ─────────────────────
CREATE OR REPLACE RULE audit_logs_no_update
  AS ON UPDATE TO audit_logs DO INSTEAD NOTHING;

CREATE OR REPLACE RULE audit_logs_no_delete
  AS ON DELETE TO audit_logs DO INSTEAD NOTHING;

COMMIT;

SELECT '005_decline_workflow ok' AS status;
