-- ============================================================
-- Migration 003 (v2 — matches actual securesign schema)
-- Requires: 002_v3 to have run successfully
-- ============================================================

BEGIN;

CREATE TABLE IF NOT EXISTS templates (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           UUID NOT NULL REFERENCES organizations(id),
  created_by       UUID NOT NULL REFERENCES users(id),
  name             VARCHAR(255) NOT NULL,
  description      TEXT,
  category         VARCHAR(50),
  -- Cloudinary fields (matching existing documents pattern)
  cloudinary_public_id  VARCHAR(500) NOT NULL DEFAULT '',
  file_path             VARCHAR(500) NOT NULL DEFAULT '',
  thumbnail_public_id   VARCHAR(500),
  fields           JSONB NOT NULL DEFAULT '[]',
  workflow_config  JSONB NOT NULL DEFAULT '[]',
  use_count        INTEGER NOT NULL DEFAULT 0,
  is_active        BOOLEAN NOT NULL DEFAULT true,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_templates_org      ON templates(org_id);
CREATE INDEX IF NOT EXISTS idx_templates_category ON templates(category);

-- updated_at trigger
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER trg_templates_updated_at
  BEFORE UPDATE ON templates
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE OR REPLACE TRIGGER trg_documents_updated_at
  BEFORE UPDATE ON documents
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE OR REPLACE TRIGGER trg_signers_updated_at
  BEFORE UPDATE ON document_signers
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Add FK from documents.template_id → templates.id
DO $$ BEGIN
  ALTER TABLE documents ADD CONSTRAINT fk_documents_template
    FOREIGN KEY (template_id) REFERENCES templates(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

COMMIT;
