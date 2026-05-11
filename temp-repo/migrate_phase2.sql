-- ============================================================================
-- Phase 2 migration — Authentication hardening
-- Run AFTER migrate_phase1.sql
-- BACKUP first: pg_dump -U youruser yourdb > backup_before_phase2.sql
-- ============================================================================

BEGIN;

-- ── 1. Users table — MFA + lockout columns ───────────────────────────────────
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS failed_attempts     INTEGER   NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS lockout_until       TIMESTAMP WITH TIME ZONE,
  ADD COLUMN IF NOT EXISTS mfa_enabled         BOOLEAN   NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS mfa_secret          TEXT,           -- live TOTP secret (encrypted in Phase 5)
  ADD COLUMN IF NOT EXISTS mfa_secret_pending  TEXT;           -- temp during setup flow

-- ── 2. Refresh tokens table ───────────────────────────────────────────────────
-- Stores SHA-256 hashes of refresh tokens — never raw token values.
CREATE TABLE IF NOT EXISTS refresh_tokens (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- SHA-256 hex digest of the raw 64-byte random token
  token_hash  VARCHAR(64) NOT NULL UNIQUE,
  expires_at  TIMESTAMP WITH TIME ZONE NOT NULL,
  revoked     BOOLEAN NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Index for the hot path: lookup by hash during refresh
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_hash    ON refresh_tokens(token_hash);
-- Index for revoking all tokens for a user (logout-all)
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user    ON refresh_tokens(user_id);
-- Index for pruning expired tokens
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_expires ON refresh_tokens(expires_at);

-- ── 3. Audit log — widen action column for new actions ───────────────────────
ALTER TABLE audit_logs
  ALTER COLUMN action TYPE VARCHAR(100);

-- ── 4. Verify ────────────────────────────────────────────────────────────────
COMMIT;

SELECT
  column_name,
  data_type,
  column_default,
  is_nullable
FROM information_schema.columns
WHERE table_name = 'users'
ORDER BY ordinal_position;
