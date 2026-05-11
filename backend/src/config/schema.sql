-- ============================================================================
-- Secure-Sign — canonical schema (Phase 1 hardened)
-- ============================================================================
-- Run the migration script below if upgrading an existing database.
-- For fresh installs run this file directly.
-- ============================================================================

CREATE TABLE IF NOT EXISTS users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email         VARCHAR(254) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  -- profile_photo stores only the filename, not a URL or full path.
  -- File is served through authenticated route only.
  profile_photo TEXT,
  created_at    TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS documents (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  original_name   VARCHAR(255) NOT NULL,
  -- file_path stores only the stored filename (no directory components).
  file_path       VARCHAR(500) NOT NULL,
  status          VARCHAR(50)  DEFAULT 'pending' CHECK (status IN ('pending', 'signed', 'revoked')),
  recipient_email VARCHAR(254),
  recipient_token UUID,         -- UUIDs are random enough; Phase 2 will add expiry
  created_at      TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS signatures (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id         UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  user_id             UUID REFERENCES users(id) ON DELETE CASCADE,
  signer_email        VARCHAR(254),
  -- Phase 1: stores SHA-256 hex digest of the signature PNG bytes.
  -- Phase 4 will replace this with a real cryptographic signature.
  signature_hash      VARCHAR(64) NOT NULL,
  sig_x               FLOAT DEFAULT 0,
  sig_y               FLOAT DEFAULT 0,
  sig_width           FLOAT DEFAULT 200,
  sig_height          FLOAT DEFAULT 80,
  page_number         INTEGER DEFAULT 1,
  verified            BOOLEAN DEFAULT FALSE,
  -- Server-controlled: 'JWT-AUTH' in Phase 1, 'RSA-SHA256' in Phase 4
  verification_method VARCHAR(100),
  signed_at           TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID REFERENCES users(id) ON DELETE SET NULL,
  document_id UUID REFERENCES documents(id) ON DELETE SET NULL,
  action      VARCHAR(100) NOT NULL,
  -- Truncated to 200 chars in application layer to prevent log injection
  device_info TEXT,
  ip_address  VARCHAR(45),    -- IPv6 max length
  timestamp   TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Indexes for common query patterns
CREATE INDEX IF NOT EXISTS idx_documents_user_id    ON documents(user_id);
CREATE INDEX IF NOT EXISTS idx_signatures_document  ON signatures(document_id);
CREATE INDEX IF NOT EXISTS idx_audit_user_id        ON audit_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_audit_document_id    ON audit_logs(document_id);