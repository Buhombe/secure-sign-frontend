-- ============================================================
-- Migration 001: Add organizations table (multi-tenant support)
-- Run BEFORE any other migrations.
-- Backward-safe: existing data gets assigned to org_id = default_org.id
-- ============================================================

BEGIN;

CREATE TABLE IF NOT EXISTS organizations (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        VARCHAR(255) NOT NULL,
  slug        VARCHAR(100) UNIQUE NOT NULL,       -- subdomain / URL key
  plan        VARCHAR(20) NOT NULL DEFAULT 'free' CHECK (plan IN ('free','pro','enterprise')),
  settings    JSONB NOT NULL DEFAULT '{
    "otp_required": false,
    "link_expiry_hours": 72,
    "sms_enabled": false,
    "whatsapp_enabled": false,
    "branding": {}
  }',
  is_active   BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Create a default org for all existing data
INSERT INTO organizations (id, name, slug, plan)
VALUES (
  '00000000-0000-0000-0000-000000000001',
  'Default Organization',
  'default',
  'pro'
) ON CONFLICT DO NOTHING;

-- Add org_id to users (non-destructive: null allowed first, then backfill, then constrain)
ALTER TABLE users ADD COLUMN IF NOT EXISTS org_id UUID REFERENCES organizations(id);

-- Backfill all existing users to the default org
UPDATE users SET org_id = '00000000-0000-0000-0000-000000000001' WHERE org_id IS NULL;

-- Now enforce NOT NULL
ALTER TABLE users ALTER COLUMN org_id SET NOT NULL;
ALTER TABLE users ALTER COLUMN org_id SET DEFAULT '00000000-0000-0000-0000-000000000001';

-- Index for org member lookups
CREATE INDEX IF NOT EXISTS idx_users_org_id ON users(org_id);

-- Add updated_at trigger function (shared)
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_organizations_updated_at
  BEFORE UPDATE ON organizations
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMIT;
