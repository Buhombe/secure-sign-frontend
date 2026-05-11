-- ============================================================================
-- Phase 8 migration — DocuSign-style multi-field signing
--   - document_fields    : per-recipient drag-and-drop fields
--   - signer_events      : timeline events for Certificate of Completion
--   - documents          : final_hash + certificate storage columns
--
-- Safe to re-run. Backward compatible — documents with no fields continue
-- to use the legacy single-signature flow.
-- BACKUP: pg_dump -U <user> -d <db> > backup_before_phase8.sql
-- ============================================================================

BEGIN;

-- ── 1. Fields placed on a document (drag-and-drop from sender UI) ─────────────
CREATE TABLE IF NOT EXISTS document_fields (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id     UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  signer_id       UUID NOT NULL REFERENCES document_signers(id) ON DELETE CASCADE,
  field_type      VARCHAR(20) NOT NULL
                  CHECK (field_type IN ('signature','initials','date','text','checkbox')),
  page_number     INTEGER NOT NULL DEFAULT 1,
  -- Positions stored as percentages (0–100) so they survive page-size changes.
  x_pct           NUMERIC(6,3) NOT NULL CHECK (x_pct      >= 0 AND x_pct      <= 100),
  y_pct           NUMERIC(6,3) NOT NULL CHECK (y_pct      >= 0 AND y_pct      <= 100),
  width_pct       NUMERIC(6,3) NOT NULL CHECK (width_pct  >  0 AND width_pct  <= 100),
  height_pct      NUMERIC(6,3) NOT NULL CHECK (height_pct >  0 AND height_pct <= 100),
  required        BOOLEAN      NOT NULL DEFAULT TRUE,
  label           VARCHAR(100),
  -- Filled value — shape depends on field_type:
  --   signature / initials  → PNG data URL (base64)
  --   date                  → ISO 8601 timestamp
  --   text                  → free text (max 500 chars, enforced in app)
  --   checkbox              → 'true' | 'false'
  value           TEXT,
  filled_at       TIMESTAMP WITH TIME ZONE,
  created_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_document_fields_document ON document_fields(document_id);
CREATE INDEX IF NOT EXISTS idx_document_fields_signer   ON document_fields(signer_id);

-- ── 2. Signer timeline events — used for Certificate of Completion ────────────
CREATE TABLE IF NOT EXISTS signer_events (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id   UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  signer_id     UUID REFERENCES document_signers(id) ON DELETE SET NULL,
  signer_email  VARCHAR(254),
  event_type    VARCHAR(30) NOT NULL
                CHECK (event_type IN ('sent','viewed','signed','declined','completed')),
  ip_address    VARCHAR(45),
  user_agent    TEXT,
  timestamp     TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_signer_events_document ON signer_events(document_id);
CREATE INDEX IF NOT EXISTS idx_signer_events_signer   ON signer_events(signer_id);
CREATE INDEX IF NOT EXISTS idx_signer_events_time     ON signer_events(timestamp);

-- ── 3. Certificate + tamper-detection fields on documents ────────────────────
ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS final_hash             VARCHAR(64),
  ADD COLUMN IF NOT EXISTS certificate_path       VARCHAR(500),
  ADD COLUMN IF NOT EXISTS certificate_public_id  VARCHAR(500),
  ADD COLUMN IF NOT EXISTS uses_fields            BOOLEAN NOT NULL DEFAULT FALSE;

COMMIT;

SELECT 'phase8 ok' AS status;
