BEGIN;

-- Table ya signers
CREATE TABLE IF NOT EXISTS document_signers (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id   UUID NOT NULL REFERENCES documents(id) ON DELETE RESTRICT,
  email         VARCHAR(254) NOT NULL,
  order_num     INTEGER NOT NULL,
  token         VARCHAR(64),
  token_expires_at TIMESTAMP WITH TIME ZONE,
  token_used    BOOLEAN NOT NULL DEFAULT FALSE,
  status        VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'signed')),
  signed_at     TIMESTAMP WITH TIME ZONE,
  created_at    TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(document_id, order_num),
  UNIQUE(document_id, email)
);

-- Ongeza column kwenye documents
ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS current_signer_order INTEGER DEFAULT 1,
  ADD COLUMN IF NOT EXISTS total_signers        INTEGER DEFAULT 1,
  ADD COLUMN IF NOT EXISTS signing_complete     BOOLEAN NOT NULL DEFAULT FALSE;

-- Index
CREATE INDEX IF NOT EXISTS idx_document_signers_document ON document_signers(document_id);
CREATE INDEX IF NOT EXISTS idx_document_signers_token    ON document_signers(token);
CREATE INDEX IF NOT EXISTS idx_document_signers_status   ON document_signers(status);

COMMIT;

SELECT column_name, data_type FROM information_schema.columns
WHERE table_name = 'document_signers' ORDER BY ordinal_position;
