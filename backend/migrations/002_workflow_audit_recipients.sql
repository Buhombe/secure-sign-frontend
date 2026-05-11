-- ============================================================
-- Migration 002 (v3 — matches actual securesign schema)
-- Tables: document_signers, documents, + new: workflow_steps, audit_events, notifications
-- ============================================================

BEGIN;

-- ── 1. Modify documents table ─────────────────────────────────
-- Already has: id, user_id, original_name, file_path, status, cloudinary fields, etc.
-- Adding: org_id, template_id, current_step, expires_at, final_cloudinary_id, hash_sha256, completed_at, updated_at

ALTER TABLE documents ADD COLUMN IF NOT EXISTS org_id               UUID REFERENCES organizations(id);
ALTER TABLE documents ADD COLUMN IF NOT EXISTS template_id          UUID;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS current_step         INTEGER DEFAULT 0;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS expires_at           TIMESTAMPTZ;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS final_cloudinary_id  VARCHAR(500);
ALTER TABLE documents ADD COLUMN IF NOT EXISTS final_file_path      VARCHAR(500);
ALTER TABLE documents ADD COLUMN IF NOT EXISTS completed_at         TIMESTAMPTZ;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS updated_at           TIMESTAMPTZ DEFAULT NOW();
ALTER TABLE documents ADD COLUMN IF NOT EXISTS title                VARCHAR(500);

-- Backfill org_id from user's org
UPDATE documents d
SET org_id = u.org_id
FROM users u
WHERE d.user_id = u.id
  AND d.org_id IS NULL;

-- Fallback: any remaining without org → default org
UPDATE documents
SET org_id = '00000000-0000-0000-0000-000000000001'
WHERE org_id IS NULL;

ALTER TABLE documents ALTER COLUMN org_id SET NOT NULL;

-- Backfill title from original_name
UPDATE documents SET title = original_name WHERE title IS NULL;

CREATE INDEX IF NOT EXISTS idx_documents_org_id  ON documents(org_id);
CREATE INDEX IF NOT EXISTS idx_documents_status  ON documents(status);
CREATE INDEX IF NOT EXISTS idx_documents_expires ON documents(expires_at) WHERE expires_at IS NOT NULL;

-- ── 2. workflow_steps (new table) ─────────────────────────────
CREATE TABLE IF NOT EXISTS workflow_steps (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id  UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  step_order   INTEGER NOT NULL,
  name         VARCHAR(255) NOT NULL,
  status       VARCHAR(20) NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending','active','completed','skipped','declined')),
  requires_all BOOLEAN NOT NULL DEFAULT true,
  completed_at TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (document_id, step_order)
);

CREATE INDEX IF NOT EXISTS idx_workflow_steps_doc ON workflow_steps(document_id);

-- ── 3. Modify document_signers table ──────────────────────────
-- Already has: id, document_id, email, order_num, token, token_expires_at, token_used, status, signed_at, created_at
-- Adding: step_id, name, phone, otp fields, signature_data, sign_method, ip_address, user_agent, declined_at, decline_reason, updated_at

ALTER TABLE document_signers ADD COLUMN IF NOT EXISTS step_id        UUID REFERENCES workflow_steps(id);
ALTER TABLE document_signers ADD COLUMN IF NOT EXISTS name           VARCHAR(255);
ALTER TABLE document_signers ADD COLUMN IF NOT EXISTS phone          VARCHAR(20);
ALTER TABLE document_signers ADD COLUMN IF NOT EXISTS role           VARCHAR(20) DEFAULT 'signer'
                                                                       CHECK (role IN ('signer','approver','viewer','cc'));
ALTER TABLE document_signers ADD COLUMN IF NOT EXISTS otp_required   BOOLEAN DEFAULT false;
ALTER TABLE document_signers ADD COLUMN IF NOT EXISTS otp_code       VARCHAR(255);
ALTER TABLE document_signers ADD COLUMN IF NOT EXISTS otp_expires_at TIMESTAMPTZ;
ALTER TABLE document_signers ADD COLUMN IF NOT EXISTS otp_attempts   INTEGER DEFAULT 0;
ALTER TABLE document_signers ADD COLUMN IF NOT EXISTS signature_data TEXT;
ALTER TABLE document_signers ADD COLUMN IF NOT EXISTS sign_method    VARCHAR(10);
ALTER TABLE document_signers ADD COLUMN IF NOT EXISTS user_agent     TEXT;
ALTER TABLE document_signers ADD COLUMN IF NOT EXISTS declined_at    TIMESTAMPTZ;
ALTER TABLE document_signers ADD COLUMN IF NOT EXISTS decline_reason TEXT;
ALTER TABLE document_signers ADD COLUMN IF NOT EXISTS updated_at     TIMESTAMPTZ DEFAULT NOW();
ALTER TABLE document_signers ADD COLUMN IF NOT EXISTS metadata       JSONB DEFAULT '{}';

-- Backfill name from email where missing
UPDATE document_signers SET name = split_part(email, '@', 1) WHERE name IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_signers_token
  ON document_signers(token) WHERE token IS NOT NULL AND token_used = false;
CREATE INDEX IF NOT EXISTS idx_signers_step  ON document_signers(step_id);
CREATE INDEX IF NOT EXISTS idx_signers_email ON document_signers(email);

-- ── 4. audit_events (new — separate from existing audit_logs) ─
-- We keep audit_logs intact and add audit_events for workflow events
CREATE TABLE IF NOT EXISTS audit_events (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id  UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  signer_id    UUID REFERENCES document_signers(id),
  user_id      UUID REFERENCES users(id),
  event_type   VARCHAR(40) NOT NULL,
  ip_address   INET,
  user_agent   TEXT,
  geo_country  CHAR(2),
  geo_city     VARCHAR(100),
  metadata     JSONB DEFAULT '{}',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_events_doc     ON audit_events(document_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_events_type    ON audit_events(event_type);
CREATE INDEX IF NOT EXISTS idx_audit_events_created ON audit_events(created_at DESC);

-- Immutability
CREATE OR REPLACE RULE audit_events_no_update AS ON UPDATE TO audit_events DO INSTEAD NOTHING;
CREATE OR REPLACE RULE audit_events_no_delete AS ON DELETE TO audit_events DO INSTEAD NOTHING;

-- ── 5. notifications (new) ────────────────────────────────────
CREATE TABLE IF NOT EXISTS notifications (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id  UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  signer_id    UUID REFERENCES document_signers(id),
  channel      VARCHAR(10) NOT NULL CHECK (channel IN ('email','sms','whatsapp')),
  type         VARCHAR(20) NOT NULL CHECK (type IN ('invitation','reminder','completed','declined','voided')),
  status       VARCHAR(10) NOT NULL DEFAULT 'queued'
                 CHECK (status IN ('queued','sent','failed','bounced')),
  external_id  VARCHAR(255),
  error        TEXT,
  sent_at      TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_notifications_doc    ON notifications(document_id);
CREATE INDEX IF NOT EXISTS idx_notifications_signer ON notifications(signer_id);

COMMIT;
