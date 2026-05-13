'use strict';

/**
 * routes/webhooks.js — HakikiSign Inbound Webhook Handler
 *
 * Handles delivery status webhooks from:
 *   - Twilio (WhatsApp message status callbacks)
 *   - Brevo (email event webhooks)
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * SECURITY MODEL
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * TWILIO WEBHOOK VALIDATION
 * ──────────────────────────
 * Twilio signs every webhook request with HMAC-SHA1 using your Auth Token.
 * The signature is in the X-Twilio-Signature header.
 * Twilio's official SDK provides validateRequest() to verify this.
 * We REJECT any request with an invalid signature.
 *
 * REPLAY ATTACK PREVENTION
 * ─────────────────────────
 * Webhook providers can (and sometimes do) replay events — either due to
 * their own retry logic or adversarial inputs.
 *
 * We prevent duplicate processing by:
 *   1. Computing SHA-256 of the raw request body
 *   2. Attempting INSERT into webhook_events with UNIQUE constraint on payload_hash
 *   3. If the INSERT conflicts → already processed → return 200 (idempotent)
 *   4. Twilio also sends a MessageSid — we also dedup on (provider, provider_event_id)
 *
 * RATE LIMITING
 * ──────────────
 * Webhook endpoints are exempt from user-facing rate limits (they don't carry
 * user credentials) but should be behind the general IP rate limiter in production.
 * On Railway, add the webhook URL to a Twilio allowlist if possible.
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * DELIVERY STATE MACHINE
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * WhatsApp message statuses from Twilio:
 *   queued      → accepted by Twilio, not yet sent to WA
 *   sent        → delivered to WhatsApp infrastructure
 *   delivered   → delivered to recipient's device
 *   read        → recipient opened the message
 *   failed      → delivery failed (permanent)
 *   undelivered → delivery failed (may be temporary)
 *
 * Our notification_logs.status machine:
 *   pending → queued → sent → delivered → read
 *                           ↘ failed
 *                           ↘ undeliverable
 */

const express = require('express');
const crypto  = require('crypto');
const twilio  = require('twilio');
const pool    = require('../config/database');
const logger  = require('../config/logger');

const router = express.Router();

// ── Twilio signature validator ────────────────────────────────────────────────

function validateTwilioSignature(req) {
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (!authToken) {
    logger.warn('[Webhook] TWILIO_AUTH_TOKEN not set — skipping signature validation (INSECURE)');
    return process.env.NODE_ENV !== 'production'; // only allow skip in dev
  }

  const twilioSig = req.headers['x-twilio-signature'];
  if (!twilioSig) return false;

  // Build the full URL as Twilio sees it (must match exactly what Twilio used)
  const webhookUrl = process.env.TWILIO_WEBHOOK_BASE_URL
    ? `${process.env.TWILIO_WEBHOOK_BASE_URL}/api/webhooks/twilio/status`
    : `${req.protocol}://${req.get('host')}${req.originalUrl}`;

  // Twilio signs urlencoded POST parameters, not JSON
  return twilio.validateRequest(authToken, twilioSig, webhookUrl, req.body);
}

// ── Brevo HMAC validation ────────────────────────────────────────────────────

function validateBrevoWebhook(req) {
  const secret = process.env.BREVO_WEBHOOK_SECRET;
  if (!secret) {
    // Brevo webhook secret is optional; skip in dev
    return process.env.NODE_ENV !== 'production';
  }

  const signature = req.headers['x-sib-signature'] || req.headers['x-brevo-signature'];
  if (!signature) return false;

  const expected = crypto
    .createHmac('sha256', secret)
    .update(JSON.stringify(req.body))
    .digest('hex');

  return crypto.timingSafeEqual(
    Buffer.from(signature, 'hex'),
    Buffer.from(expected,  'hex')
  );
}

// ── Payload hash for replay prevention ───────────────────────────────────────

function hashPayload(body) {
  return crypto
    .createHash('sha256')
    .update(typeof body === 'string' ? body : JSON.stringify(body))
    .digest('hex');
}

// ── Record and dedup webhook event ───────────────────────────────────────────

/**
 * recordWebhookEvent
 *
 * Inserts a row into webhook_events.
 * Returns { isNew: true, eventId } if this is a new event.
 * Returns { isNew: false } if already processed (conflict on payload_hash).
 */
async function recordWebhookEvent({ provider, eventType, payloadHash, providerEventId, payload }) {
  try {
    const result = await pool.query(
      `INSERT INTO webhook_events
         (provider, event_type, payload_hash, provider_event_id, payload)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (payload_hash) DO NOTHING
       RETURNING id`,
      [provider, eventType, payloadHash, providerEventId, JSON.stringify(payload)]
    );

    if (result.rows.length === 0) {
      return { isNew: false };
    }

    return { isNew: true, eventId: result.rows[0].id };
  } catch (err) {
    logger.error('[Webhook] Failed to record event', { message: err.message });
    return { isNew: true, eventId: null }; // optimistic: process anyway
  }
}

async function markWebhookProcessed(eventId, error = null) {
  if (!eventId) return;
  await pool.query(
    `UPDATE webhook_events
     SET processed = true, processed_at = NOW(), error = $2
     WHERE id = $1`,
    [eventId, error]
  ).catch(err => logger.error('[Webhook] markProcessed failed', { message: err.message }));
}

// ── notification_logs update ──────────────────────────────────────────────────

const TWILIO_TO_LOG_STATUS = {
  queued:      'queued',
  sent:        'sent',
  delivered:   'delivered',
  read:        'read',
  failed:      'failed',
  undelivered: 'undeliverable',
};

async function updateNotificationLogByProviderId(messageSid, twilioStatus, errorCode) {
  const logStatus = TWILIO_TO_LOG_STATUS[twilioStatus] || 'queued';

  // Determine which timestamp column to set
  const tsColumn = {
    queued:      null,
    sent:        'sent_at',
    delivered:   'delivered_at',
    read:        'read_at',
    failed:      'failed_at',
    undelivered: 'failed_at',
  }[twilioStatus];

  const query = tsColumn
    ? `UPDATE notification_logs
       SET status = $2, ${tsColumn} = NOW(), error_code = $3
       WHERE provider_id = $1 AND status != $2`
    : `UPDATE notification_logs
       SET status = $2, error_code = $3
       WHERE provider_id = $1 AND status != $2`;

  await pool.query(query, [messageSid, logStatus, errorCode || null]);
}

// ═════════════════════════════════════════════════════════════════════════════
// TWILIO STATUS CALLBACK
// POST /api/webhooks/twilio/status
//
// Called by Twilio for every status change on a message we sent.
// Twilio sends application/x-www-form-urlencoded (not JSON).
// ═════════════════════════════════════════════════════════════════════════════

router.post(
  '/twilio/status',
  express.urlencoded({ extended: false }),  // parse Twilio's form-encoded body
  async (req, res) => {
    // 1. Validate signature
    if (!validateTwilioSignature(req)) {
      logger.warn('[Webhook/Twilio] Invalid signature', {
        ip: req.ip,
        ua: req.headers['user-agent']?.slice(0, 80),
      });
      return res.status(403).send('Forbidden');
    }

    const {
      MessageSid,
      MessageStatus,
      To,
      From,
      ErrorCode,
    } = req.body;

    if (!MessageSid || !MessageStatus) {
      return res.status(400).send('Missing required fields');
    }

    const payloadHash = hashPayload(req.body);

    // 2. Replay prevention
    const { isNew, eventId } = await recordWebhookEvent({
      provider:        'twilio',
      eventType:       `message.${MessageStatus}`,
      payloadHash,
      providerEventId: MessageSid,
      payload:         req.body,
    });

    if (!isNew) {
      logger.debug('[Webhook/Twilio] Duplicate event — skipping', { MessageSid, MessageStatus });
      return res.status(200).send('OK'); // idempotent
    }

    logger.info('[Webhook/Twilio] Status update', {
      sid:    MessageSid,
      status: MessageStatus,
      to:     To?.replace(/\d{4}$/, '****'), // mask last 4 digits
      code:   ErrorCode,
    });

    let processingError = null;
    try {
      await updateNotificationLogByProviderId(MessageSid, MessageStatus, ErrorCode);
    } catch (err) {
      processingError = err.message;
      logger.error('[Webhook/Twilio] Failed to update notification_log', {
        messageSid:  MessageSid,
        messageStatus: MessageStatus,
        error: err.message,
      });
    }

    await markWebhookProcessed(eventId, processingError);

    // Twilio requires a 200 response to stop retrying
    res.status(200).send('OK');
  }
);

// ═════════════════════════════════════════════════════════════════════════════
// BREVO EMAIL EVENT WEBHOOK
// POST /api/webhooks/brevo/events
//
// Brevo sends JSON arrays of events.
// Configure in Brevo dashboard: Settings → Webhooks → Transactional
// Events: delivered, hard_bounce, soft_bounce, spam, unsubscribe, blocked
// ═════════════════════════════════════════════════════════════════════════════

router.post(
  '/brevo/events',
  express.json(),
  async (req, res) => {
    if (!validateBrevoWebhook(req)) {
      logger.warn('[Webhook/Brevo] Invalid signature', { ip: req.ip });
      return res.status(403).send('Forbidden');
    }

    // Brevo sends events as array or single object
    const events = Array.isArray(req.body) ? req.body : [req.body];

    for (const event of events) {
      const { event: eventType, 'message-id': messageId, email, ts_event } = event;

      if (!messageId) continue;

      const payloadHash = hashPayload({ messageId, eventType, email, ts_event });

      const { isNew, eventId } = await recordWebhookEvent({
        provider:        'brevo',
        eventType:       eventType || 'unknown',
        payloadHash,
        providerEventId: messageId,
        payload:         event,
      });

      if (!isNew) continue;

      // Map Brevo events to our status
      const brevoStatusMap = {
        delivered:    'delivered',
        hard_bounce:  'bounced',
        soft_bounce:  'failed',
        spam:         'failed',
        blocked:      'failed',
        unsubscribe:  'failed',
        opened:       'read',
        clicks:       'read',
      };

      const logStatus = brevoStatusMap[eventType] || 'sent';

      let processingError = null;
      try {
        await pool.query(
          `UPDATE notification_logs
           SET status = $2,
               delivered_at = CASE WHEN $2 = 'delivered' THEN NOW() ELSE delivered_at END,
               read_at      = CASE WHEN $2 = 'read'      THEN NOW() ELSE read_at END,
               failed_at    = CASE WHEN $2 IN ('failed', 'bounced') THEN NOW() ELSE failed_at END
           WHERE provider_id = $1`,
          [messageId, logStatus]
        );
      } catch (err) {
        processingError = err.message;
        logger.error('[Webhook/Brevo] Failed to update notification_log', {
          messageId, eventType, error: err.message,
        });
      }

      await markWebhookProcessed(eventId, processingError);

      logger.info('[Webhook/Brevo] Event processed', {
        eventType,
        messageId,
        email: email?.replace(/(.{2}).*@/, '$1***@'), // partial mask
        status: logStatus,
      });
    }

    res.status(200).json({ received: events.length });
  }
);

// ═════════════════════════════════════════════════════════════════════════════
// HEALTH CHECK (for monitoring)
// GET /api/webhooks/health
// ═════════════════════════════════════════════════════════════════════════════

router.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

module.exports = router;
