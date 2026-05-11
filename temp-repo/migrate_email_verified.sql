BEGIN;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS email_verified              BOOLEAN   NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS email_verification_token    VARCHAR(64),
  ADD COLUMN IF NOT EXISTS email_verification_sent_at  TIMESTAMP WITH TIME ZONE;

UPDATE users SET email_verified = TRUE WHERE email_verified IS NULL;

COMMIT;
