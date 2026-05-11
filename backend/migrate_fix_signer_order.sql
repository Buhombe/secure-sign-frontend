BEGIN;
ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS current_signer_order INTEGER NOT NULL DEFAULT 1;
COMMIT;
SELECT 'signer_order fix ok' AS status;
