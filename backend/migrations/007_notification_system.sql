-- =============================================================================
-- Migration 007 — Enterprise Multi-Channel Notification System
-- HakikiSign — WhatsApp-first East African notification infrastructure
-- =============================================================================
-- Apply with: psql $DATABASE_URL -f migrations/007_notification_system.sql
-- Safe to re-run (all statements use IF NOT EXISTS / IF EXISTS guards).
-- =============================================================================

BEGIN;

-- ── 1. User notification preferences ─────────────────────────────────────────
-- One row per user. Created on-demand; absence means system defaults.
CREATE TABLE IF NOT EXISTS notification_preferences (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id              UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,

  -- Primary channel for invitations, reminders, completions
  primary_channel      VARCHAR(10) NOT NULL DEFAULT 'whatsapp'
                         CHECK (primary_channel IN ('whatsapp', 'email')),

  -- Fallback channel if primary delivery fails
  fallback_channel     VARCHAR(10) NOT NULL DEFAULT 'email'
                         CHECK (fallback_channel IN ('whatsapp', 'email', 'none')),

  -- Whether to receive signing reminders
  reminders_enabled    BOOLEAN NOT NULL DEFAULT true,

  -- How many hours after invitation before first reminder
  reminder_delay_hours INTEGER NOT NULL DEFAULT 24
                         CHECK (reminder_delay_hours BETWEEN 1 AND 168),

  -- Whether to receive completion notifications
  completion_enabled   BOOLEAN NOT NULL DEFAULT true,

  -- Language preference for templates (ISO 639-1)
  language             CHAR(2) NOT NULL DEFAULT 'en'
                         CHECK (language IN ('en', 'sw')),

  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_notif_prefs_user ON notification_preferences(user_id);

-- ── 2. Notification delivery log ─────────────────────────────────────────────
-- Full audit trail of every notification attempt including retries.
-- Replaces the thin `notifications` table from migration 002.
-- The existing `notifications` table is kept — this is ADDITIVE.
CREATE TABLE IF NOT EXISTS notification_logs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Context
  document_id     UUID REFERENCES documents(id) ON DELETE SET NULL,
  signer_id       UUID REFERENCES document_signers(id) ON DELETE SET NULL,
  user_id         UUID REFERENCES users(id) ON DELETE SET NULL,

  -- What was sent
  notification_type VARCHAR(30) NOT NULL
                      CHECK (notification_type IN (
                        'signing_invite', 'reminder', 'completion',
                        'decline', 'otp', 'void', 'expiry_warning'
                      )),

  channel         VARCHAR(10) NOT NULL CHECK (channel IN ('whatsapp', 'email', 'sms')),

  -- Who received it
  recipient       VARCHAR(254) NOT NULL,  -- phone number or email address

  -- Template used (references notification_templates.key)
  template_key    VARCHAR(80),

  -- BullMQ job tracking
  job_id          VARCHAR(255),
  attempt_number  SMALLINT NOT NULL DEFAULT 1,

  -- Provider response
  status          VARCHAR(15) NOT NULL DEFAULT 'pending'
                    CHECK (status IN (
                      'pending', 'queued', 'sent', 'delivered',
                      'read', 'failed', 'undeliverable', 'bounced'
                    )),

  -- External provider message ID (WhatsApp message SID, Brevo messageId, etc.)
  provider_id     VARCHAR(255),

  -- Error detail for failed attempts
  error_code      VARCHAR(50),
  error_message   TEXT,

  -- Timing
  queued_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sent_at         TIMESTAMPTZ,
  delivered_at    TIMESTAMPTZ,
  read_at         TIMESTAMPTZ,
  failed_at       TIMESTAMPTZ,

  -- Whether this was a fallback delivery (primary channel failed)
  is_fallback     BOOLEAN NOT NULL DEFAULT false,

  -- Idempotency key — prevents duplicate sends across retries
  idempotency_key VARCHAR(255),

  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_notif_log_document   ON notification_logs(document_id);
CREATE INDEX IF NOT EXISTS idx_notif_log_signer     ON notification_logs(signer_id);
CREATE INDEX IF NOT EXISTS idx_notif_log_status     ON notification_logs(status);
CREATE INDEX IF NOT EXISTS idx_notif_log_created    ON notification_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notif_log_provider   ON notification_logs(provider_id) WHERE provider_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_notif_log_idem ON notification_logs(idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- ── 3. Notification templates ─────────────────────────────────────────────────
-- Managed templates with variable substitution support.
-- The application ships with seed data below; operators can override in DB.
CREATE TABLE IF NOT EXISTS notification_templates (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Unique lookup key: "<type>_<channel>_<language>"
  -- e.g. "signing_invite_whatsapp_en"
  key        VARCHAR(80) NOT NULL UNIQUE,

  type       VARCHAR(30) NOT NULL,
  channel    VARCHAR(10) NOT NULL CHECK (channel IN ('whatsapp', 'email', 'sms')),
  language   CHAR(2)     NOT NULL DEFAULT 'en',

  -- Display name for admin UI
  name       VARCHAR(120) NOT NULL,

  -- Template body with {{variable}} placeholders
  -- WhatsApp: plain text, emoji allowed, 1024 char limit
  -- Email: subject stored separately; body is HTML
  subject    TEXT,   -- email only
  body       TEXT    NOT NULL,

  -- Whether this template is active
  active     BOOLEAN NOT NULL DEFAULT true,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── 4. Webhook event log — replay attack prevention ──────────────────────────
-- Records every inbound webhook from WhatsApp/Twilio/Brevo.
-- Used for:
--   a) Idempotency: duplicate deliveries from providers are ignored
--   b) Replay attack prevention: signed webhook payloads are stored by hash
--   c) Audit: full incoming event history for debugging
CREATE TABLE IF NOT EXISTS webhook_events (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider     VARCHAR(20) NOT NULL CHECK (provider IN ('twilio', 'brevo', 'meta_cloud', 'africastalking')),
  event_type   VARCHAR(50) NOT NULL,

  -- SHA-256 of the raw request body — used for dedup and replay protection
  payload_hash VARCHAR(64) NOT NULL,

  -- Provider-assigned message/event ID
  provider_event_id VARCHAR(255),

  -- Raw payload stored for debugging (strip PII in production scrub job)
  payload      JSONB,

  -- Processing result
  processed    BOOLEAN NOT NULL DEFAULT false,
  processed_at TIMESTAMPTZ,
  error        TEXT,

  received_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_webhook_hash
  ON webhook_events(payload_hash);
CREATE INDEX IF NOT EXISTS idx_webhook_provider_event
  ON webhook_events(provider, provider_event_id) WHERE provider_event_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_webhook_received
  ON webhook_events(received_at DESC);

-- ── 5. OTP rate limiting table ────────────────────────────────────────────────
-- Tracks OTP send attempts per phone/email to prevent abuse.
-- Separate from otp_attempts on document_signers (that's per-signer verify attempts).
CREATE TABLE IF NOT EXISTS otp_send_log (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  recipient  VARCHAR(254) NOT NULL,  -- phone or email
  channel    VARCHAR(10)  NOT NULL,
  sent_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  document_id UUID REFERENCES documents(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_otp_send_recipient
  ON otp_send_log(recipient, sent_at DESC);

-- ── 6. Add notification tracking columns to document_signers ─────────────────
-- Track reminder count and last notification time for anti-spam logic
ALTER TABLE document_signers
  ADD COLUMN IF NOT EXISTS reminders_sent    SMALLINT    DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_reminded_at  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS whatsapp_phone    VARCHAR(20),    -- verified E.164 phone for WA delivery
  ADD COLUMN IF NOT EXISTS notif_channel     VARCHAR(10) DEFAULT 'email'
                                               CHECK (notif_channel IN ('whatsapp', 'email', 'sms'));

-- ── 7. Seed default templates ─────────────────────────────────────────────────

-- WhatsApp / English
INSERT INTO notification_templates (key, type, channel, language, name, body)
VALUES
(
  'signing_invite_whatsapp_en',
  'signing_invite', 'whatsapp', 'en',
  'Signing Invitation (WhatsApp/EN)',
  E'✍️ *HakikiSign* — Signature Request\n\nHabari {{signer_name}},\n\n*{{sender_name}}* amekuomba utie saini kwenye:\n📄 *{{document_title}}*\n\nBonyeza kiungo hiki kusaini:\n{{signing_link}}\n\n⏰ Kiungo hiki muda wake ni masaa *{{expiry_hours}}*.\n🔒 Salama na ya kisheria.\n\n_Ukifikiri ujumbe huu si wako, punguza._'
),
(
  'signing_invite_whatsapp_sw',
  'signing_invite', 'whatsapp', 'sw',
  'Mwaliko wa Kusaini (WhatsApp/SW)',
  E'✍️ *HakikiSign* — Ombi la Saini\n\nHabari {{signer_name}},\n\n*{{sender_name}}* amekuomba utie saini kwenye:\n📄 *{{document_title}}*\n\nBonyeza kusaini:\n{{signing_link}}\n\n⏰ Muda: masaa *{{expiry_hours}}*.\n🔒 Salama.'
),
(
  'reminder_whatsapp_en',
  'reminder', 'whatsapp', 'en',
  'Reminder (WhatsApp/EN)',
  E'⏰ *HakikiSign Reminder*\n\nHi {{signer_name}}, you still need to sign:\n📄 *{{document_title}}*\n\nSign here: {{signing_link}}\n\n_{{reminders_left}} reminder(s) remaining. Expires in {{expiry_hours}} hours._'
),
(
  'reminder_whatsapp_sw',
  'reminder', 'whatsapp', 'sw',
  'Kikumbusha (WhatsApp/SW)',
  E'⏰ *Kikumbusha — HakikiSign*\n\nHabari {{signer_name}}, bado hujatia saini:\n📄 *{{document_title}}*\n\nSaini hapa: {{signing_link}}\n\n_Inaisha masaa {{expiry_hours}}._'
),
(
  'completion_whatsapp_en',
  'completion', 'whatsapp', 'en',
  'Completion Notice (WhatsApp/EN)',
  E'✅ *HakikiSign* — Document Complete\n\nHi {{owner_name}},\n\n*{{document_title}}* has been signed by all parties.\n\n👤 Signers: {{signer_list}}\n\nLog in to download your signed document:\n{{dashboard_link}}\n\n_Secured with cryptographic audit trail._'
),
(
  'decline_whatsapp_en',
  'decline', 'whatsapp', 'en',
  'Decline Notice (WhatsApp/EN)',
  E'❌ *HakikiSign* — Signing Declined\n\nHi {{owner_name}},\n\n*{{signer_name}}* has declined to sign *{{document_title}}*.\n\n📝 Reason: {{decline_reason}}\n\nThe signing workflow has been stopped. Visit your dashboard to take action:\n{{dashboard_link}}'
),
(
  'otp_whatsapp_en',
  'otp', 'whatsapp', 'en',
  'OTP Verification (WhatsApp/EN)',
  E'🔐 *HakikiSign* — Verification Code\n\nYour one-time code to sign *{{document_title}}* is:\n\n*{{otp_code}}*\n\n⏰ Valid for {{otp_expiry_minutes}} minutes.\n\n_Never share this code. HakikiSign will never ask for it by phone._'
),
(
  'expiry_warning_whatsapp_en',
  'expiry_warning', 'whatsapp', 'en',
  'Expiry Warning (WhatsApp/EN)',
  E'⚠️ *HakikiSign* — Link Expiring Soon\n\n{{document_title}} signing link expires in *{{hours_left}} hours*.\n\nSign now before it expires:\n{{signing_link}}'
)
ON CONFLICT (key) DO NOTHING;

-- Email templates (subject + HTML body handled by emailService; these are text fallbacks)
INSERT INTO notification_templates (key, type, channel, language, name, subject, body)
VALUES
(
  'signing_invite_email_en',
  'signing_invite', 'email', 'en',
  'Signing Invitation (Email/EN)',
  'You have a document ready to sign — {{document_title}}',
  'Hi {{signer_name}}, {{sender_name}} has requested your signature on "{{document_title}}". Sign here: {{signing_link}} (expires {{expiry_hours}} hours).'
),
(
  'reminder_email_en',
  'reminder', 'email', 'en',
  'Reminder (Email/EN)',
  'Reminder: {{document_title}} awaits your signature',
  'Hi {{signer_name}}, you still need to sign "{{document_title}}". Sign here: {{signing_link}}'
),
(
  'completion_email_en',
  'completion', 'email', 'en',
  'Completion Notice (Email/EN)',
  'Document fully signed: {{document_title}}',
  'Hi {{owner_name}}, all parties have signed "{{document_title}}". View at {{dashboard_link}}'
),
(
  'decline_email_en',
  'decline', 'email', 'en',
  'Decline Notice (Email/EN)',
  'Signing declined: {{document_title}}',
  'Hi {{owner_name}}, {{signer_name}} has declined to sign "{{document_title}}". Reason: {{decline_reason}}'
),
(
  'otp_email_en',
  'otp', 'email', 'en',
  'OTP Verification (Email/EN)',
  'Your HakikiSign verification code',
  'Your one-time code to sign "{{document_title}}" is: {{otp_code}} (valid {{otp_expiry_minutes}} min)'
)
ON CONFLICT (key) DO NOTHING;

COMMIT;
