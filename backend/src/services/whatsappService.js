'use strict';

/**
 * whatsappService.js — HakikiSign WhatsApp Delivery Layer
 *
 * Provider: Twilio WhatsApp Business API (twilio package already in package.json).
 * Twilio is the production choice for East Africa:
 *   - Established TZ/KE/UG connectivity
 *   - Reliable delivery receipts via webhook
 *   - Supports both WhatsApp Business and SMS fallback on same Twilio number
 *   - Free sandbox for testing (twilio.com/whatsapp/sandbox)
 *
 * ARCHITECTURE
 * ─────────────
 * This module provides LOW-LEVEL send primitives.
 * The NotificationOrchestrator (notificationOrchestrator.js) decides WHICH
 * channel to use and calls these functions.
 *
 * PHONE NUMBER FORMAT
 * ────────────────────
 * All phone numbers MUST be in E.164 format: +255712345678
 * Tanzanian mobile numbers:
 *   Vodacom:  +255 7XX XXX XXX
 *   Airtel:   +255 6XX XXX XXX  (also 7XX)
 *   Tigo:     +255 7XX XXX XXX
 *   Halotel:  +255 6XX XXX XXX
 * The normalizePhone() helper handles common local formats.
 *
 * ERROR TAXONOMY
 * ──────────────
 * Twilio error codes we handle specifically:
 *   21211  — Invalid 'To' phone number (permanent — do not retry)
 *   21408  — Permission to send SMS/WA has not been enabled
 *   21610  — Message blocked — recipient opted out (permanent)
 *   63016  — Failed to send freeform WhatsApp message outside 24hr window
 *   63018  — Recipient's WhatsApp number is inactive (permanent)
 *   21614  — 'To' number is not a valid mobile number (permanent)
 *   20429  — Rate limit exceeded (transient — back off)
 *
 * PERMANENT vs TRANSIENT
 * ───────────────────────
 * Permanent errors throw { code: '...', permanent: true }.
 * The worker checks this flag and does NOT retry permanent failures.
 * Instead it triggers the email fallback path.
 */

const twilio = require('twilio');
const logger = require('../config/logger');
const pool   = require('../config/database');

// ── Twilio client (lazy init to allow unit testing without credentials) ───────
let _client = null;
function getClient() {
  if (_client) return _client;
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken  = process.env.TWILIO_AUTH_TOKEN;
  if (!accountSid || !authToken) {
    throw new Error('[WhatsApp] TWILIO_ACCOUNT_SID or TWILIO_AUTH_TOKEN not set');
  }
  _client = twilio(accountSid, authToken);
  return _client;
}

const WHATSAPP_FROM = process.env.TWILIO_WHATSAPP_FROM
  ? `whatsapp:${process.env.TWILIO_WHATSAPP_FROM.replace(/^whatsapp:/, '')}`
  : null;

// Permanent Twilio error codes — do not retry; trigger fallback immediately
const PERMANENT_ERROR_CODES = new Set([
  '21211', '21408', '21610', '21614', '63018', '21219',
  '63003', '63005', '63007',
]);

// ── Phone number normalisation ────────────────────────────────────────────────

/**
 * Normalise a phone number to E.164 format.
 * Handles common Tanzanian input patterns:
 *   0712345678  → +255712345678
 *   255712345678 → +255712345678
 *   +255712345678 → +255712345678 (pass-through)
 *
 * For other East African numbers, pass in with country code already.
 * Returns null if the number is clearly invalid.
 */
function normalizePhone(raw, defaultCountry = '255') {
  if (!raw || typeof raw !== 'string') return null;

  // Strip whitespace, dashes, parentheses
  let cleaned = raw.replace(/[\s\-().]/g, '');

  // Already E.164
  if (cleaned.startsWith('+') && cleaned.length >= 10) return cleaned;

  // Has country code without +
  if (cleaned.startsWith(defaultCountry)) return `+${cleaned}`;

  // Local Tanzanian format: starts with 0
  if (cleaned.startsWith('0') && cleaned.length === 10) {
    return `+${defaultCountry}${cleaned.slice(1)}`;
  }

  // 9-digit local (missing leading zero in some inputs)
  if (cleaned.length === 9 && !cleaned.startsWith('0')) {
    return `+${defaultCountry}${cleaned}`;
  }

  return null;
}

/**
 * Validates that a normalised E.164 number looks plausible.
 * Not a full validator — Twilio will reject genuinely invalid ones.
 */
function isValidE164(phone) {
  return /^\+\d{7,15}$/.test(phone);
}

// ── Core send function ────────────────────────────────────────────────────────

/**
 * sendWhatsAppMessage — send a single WhatsApp message via Twilio.
 *
 * @param {object} opts
 * @param {string}  opts.to            E.164 phone number
 * @param {string}  opts.body          Message text (max 1600 chars for WA)
 * @param {string}  [opts.idempotencyKey]  Optional dedup key
 * @returns {Promise<{ messageSid: string, status: string }>}
 * @throws  With .permanent = true for non-retryable errors
 */
async function sendWhatsAppMessage({ to, body, idempotencyKey }) {
  if (!WHATSAPP_FROM) {
    throw new Error('[WhatsApp] TWILIO_WHATSAPP_FROM not configured');
  }

  const phone = normalizePhone(to);
  if (!phone || !isValidE164(phone)) {
    const err = new Error(`[WhatsApp] Invalid phone number: ${to}`);
    err.permanent = true;
    err.code = 'INVALID_PHONE';
    throw err;
  }

  // Truncate to WhatsApp limit
  const safeBody = body.length > 1600 ? body.slice(0, 1597) + '...' : body;

  try {
    const msg = await getClient().messages.create({
      from: WHATSAPP_FROM,
      to:   `whatsapp:${phone}`,
      body: safeBody,
      ...(idempotencyKey ? { idempotencyKey } : {}),
    });

    logger.info('[WhatsApp] Message sent', {
      to:    phone.slice(0, -4) + '****',   // partial mask for logs
      sid:   msg.sid,
      status: msg.status,
    });

    return { messageSid: msg.sid, status: msg.status };

  } catch (err) {
    const code = String(err.code);
    const isPermanent = PERMANENT_ERROR_CODES.has(code);

    logger.error('[WhatsApp] Send failed', {
      to:        phone.slice(0, -4) + '****',
      code,
      message:   err.message,
      permanent: isPermanent,
    });

    err.permanent = isPermanent;
    throw err;
  }
}

// ── High-level notification senders ──────────────────────────────────────────

/**
 * sendSigningInviteWhatsApp
 *
 * Sends a signing invitation via WhatsApp.
 * Returns { messageSid, status } on success.
 */
async function sendSigningInviteWhatsApp({
  to,
  signerName,
  senderName,
  documentTitle,
  signingLink,
  expiryHours = 72,
  language = 'en',
  idempotencyKey,
}) {
  const body = _renderTemplate('signing_invite', language, {
    signer_name:    signerName || extractNameFromPhone(to),
    sender_name:    senderName || 'HakikiSign User',
    document_title: documentTitle,
    signing_link:   signingLink,
    expiry_hours:   String(expiryHours),
  });

  return sendWhatsAppMessage({ to, body, idempotencyKey });
}

/**
 * sendReminderWhatsApp
 */
async function sendReminderWhatsApp({
  to,
  signerName,
  documentTitle,
  signingLink,
  expiryHours,
  remindersLeft = 0,
  language = 'en',
  idempotencyKey,
}) {
  const body = _renderTemplate('reminder', language, {
    signer_name:     signerName || extractNameFromPhone(to),
    document_title:  documentTitle,
    signing_link:    signingLink,
    expiry_hours:    String(Math.max(0, Math.round(expiryHours))),
    reminders_left:  String(remindersLeft),
  });

  return sendWhatsAppMessage({ to, body, idempotencyKey });
}

/**
 * sendCompletionWhatsApp — notify document owner that signing is complete.
 */
async function sendCompletionWhatsApp({
  to,
  ownerName,
  documentTitle,
  signerList,       // array of strings e.g. ['Alice', 'Bob']
  dashboardLink,
  language = 'en',
  idempotencyKey,
}) {
  const body = _renderTemplate('completion', language, {
    owner_name:     ownerName || 'there',
    document_title: documentTitle,
    signer_list:    signerList.join(', '),
    dashboard_link: dashboardLink,
  });

  return sendWhatsAppMessage({ to, body, idempotencyKey });
}

/**
 * sendDeclineWhatsApp — notify document owner that a signer declined.
 */
async function sendDeclineWhatsApp({
  to,
  ownerName,
  documentTitle,
  signerName,
  declineReason,
  dashboardLink,
  language = 'en',
  idempotencyKey,
}) {
  const body = _renderTemplate('decline', language, {
    owner_name:     ownerName || 'there',
    document_title: documentTitle,
    signer_name:    signerName,
    decline_reason: declineReason || 'No reason provided.',
    dashboard_link: dashboardLink,
  });

  return sendWhatsAppMessage({ to, body, idempotencyKey });
}

/**
 * sendOtpWhatsApp — deliver OTP verification code via WhatsApp.
 *
 * Anti-abuse: caller must pass the result of checkOtpSendRateLimit() first.
 */
async function sendOtpWhatsApp({
  to,
  otpCode,
  documentTitle,
  expiryMinutes = 10,
  language = 'en',
  idempotencyKey,
}) {
  const body = _renderTemplate('otp', language, {
    document_title:      documentTitle,
    otp_code:            otpCode,
    otp_expiry_minutes:  String(expiryMinutes),
  });

  return sendWhatsAppMessage({ to, body, idempotencyKey });
}

/**
 * sendExpiryWarningWhatsApp — warn signer their link expires soon.
 */
async function sendExpiryWarningWhatsApp({
  to,
  documentTitle,
  signingLink,
  hoursLeft,
  language = 'en',
  idempotencyKey,
}) {
  const body = _renderTemplate('expiry_warning', language, {
    document_title: documentTitle,
    signing_link:   signingLink,
    hours_left:     String(Math.round(hoursLeft)),
  });

  return sendWhatsAppMessage({ to, body, idempotencyKey });
}

// ── Template rendering ────────────────────────────────────────────────────────

// In-memory template cache, populated from DB on first use.
// Templates defined in migration 007 seed data.
const _templateCache = new Map();

/**
 * _renderTemplate — load from DB cache and substitute {{variable}} placeholders.
 *
 * Falls back to a hardcoded default if the DB template is missing.
 * This ensures delivery works even during DB migrations.
 */
function _renderTemplate(type, language, vars) {
  const key = `${type}_whatsapp_${language}`;
  let tpl = _templateCache.get(key);

  if (!tpl) {
    // Synchronous fallback — will be replaced by async DB fetch in worker
    tpl = _hardcodedFallback(type, language);
  }

  if (!tpl) {
    throw new Error(`[WhatsApp] No template found for key: ${key}`);
  }

  // Replace {{variable}} with values; strip unresolved placeholders
  return tpl.replace(/\{\{(\w+)\}\}/g, (_, name) => {
    const val = vars[name];
    return val !== undefined && val !== null ? String(val) : '';
  });
}

/**
 * loadTemplatesFromDb — warm the template cache from the DB.
 * Call once at worker startup.
 */
async function loadTemplatesFromDb() {
  try {
    const result = await pool.query(
      `SELECT key, body FROM notification_templates
       WHERE channel = 'whatsapp' AND active = true`
    );
    result.rows.forEach(row => _templateCache.set(row.key, row.body));
    logger.info('[WhatsApp] Templates loaded', { count: result.rows.length });
  } catch (err) {
    logger.error('[WhatsApp] Failed to load templates from DB; using hardcoded fallbacks', {
      message: err.message,
    });
  }
}

/**
 * Hardcoded fallback templates — used if DB is unavailable.
 * Intentionally minimal and safe.
 */
function _hardcodedFallback(type, language) {
  const defaults = {
    signing_invite_whatsapp_en:
      '✍️ *HakikiSign* — You have a document to sign\n\n📄 *{{document_title}}*\n\nSign here: {{signing_link}}\n\n⏰ Expires in {{expiry_hours}} hours.',
    signing_invite_whatsapp_sw:
      '✍️ *HakikiSign* — Una hati ya kusaini\n\n📄 *{{document_title}}*\n\nSaini hapa: {{signing_link}}\n\n⏰ Inaisha masaa {{expiry_hours}}.',
    reminder_whatsapp_en:
      '⏰ *HakikiSign Reminder* — Please sign *{{document_title}}*\n\n{{signing_link}}\n\nExpires in {{expiry_hours}} hours.',
    reminder_whatsapp_sw:
      '⏰ *Kikumbusha* — Tafadhali saini *{{document_title}}*\n\n{{signing_link}}',
    completion_whatsapp_en:
      '✅ *HakikiSign* — *{{document_title}}* has been signed by all parties.\n\nView: {{dashboard_link}}',
    decline_whatsapp_en:
      '❌ *HakikiSign* — *{{signer_name}}* declined to sign *{{document_title}}*.\n\nReason: {{decline_reason}}\n\n{{dashboard_link}}',
    otp_whatsapp_en:
      '🔐 *HakikiSign* — Your verification code is:\n\n*{{otp_code}}*\n\nValid for {{otp_expiry_minutes}} minutes.',
    expiry_warning_whatsapp_en:
      '⚠️ *HakikiSign* — *{{document_title}}* signing link expires in {{hours_left}} hours.\n\n{{signing_link}}',
  };

  const key = `${type}_whatsapp_${language}`;
  return defaults[key] || defaults[`${type}_whatsapp_en`] || null;
}

// ── OTP abuse prevention ──────────────────────────────────────────────────────

/**
 * checkOtpSendRateLimit
 *
 * Ensures a phone/email recipient cannot receive more than:
 *   - 3 OTPs per 10-minute window
 *   - 10 OTPs per hour
 *
 * Throws { code: 'OTP_RATE_LIMIT', message: '...' } if exceeded.
 * Caller should return HTTP 429 to client.
 *
 * @param {string} recipient   phone or email
 * @param {string} channel     'whatsapp' | 'email' | 'sms'
 * @param {string} [documentId]
 */
async function checkOtpSendRateLimit(recipient, channel, documentId = null) {
  const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000);
  const oneHourAgo    = new Date(Date.now() - 60 * 60 * 1000);

  const [shortWindow, hourWindow] = await Promise.all([
    pool.query(
      `SELECT COUNT(*) FROM otp_send_log
       WHERE recipient = $1 AND channel = $2 AND sent_at > $3`,
      [recipient, channel, tenMinutesAgo]
    ),
    pool.query(
      `SELECT COUNT(*) FROM otp_send_log
       WHERE recipient = $1 AND channel = $2 AND sent_at > $3`,
      [recipient, channel, oneHourAgo]
    ),
  ]);

  const shortCount = parseInt(shortWindow.rows[0].count, 10);
  const hourCount  = parseInt(hourWindow.rows[0].count, 10);

  if (shortCount >= 3) {
    const err = new Error('Too many OTP requests. Please wait 10 minutes.');
    err.code = 'OTP_RATE_LIMIT';
    err.retryAfterSeconds = 600;
    throw err;
  }

  if (hourCount >= 10) {
    const err = new Error('OTP hourly limit exceeded. Please try again later.');
    err.code = 'OTP_RATE_LIMIT';
    err.retryAfterSeconds = 3600;
    throw err;
  }

  // Record this attempt
  await pool.query(
    `INSERT INTO otp_send_log (recipient, channel, document_id) VALUES ($1, $2, $3)`,
    [recipient, channel, documentId]
  );
}

// ── Utility ───────────────────────────────────────────────────────────────────

function extractNameFromPhone(phone) {
  // Produce a friendly placeholder when we don't have a name
  return phone ? `signer (${phone.slice(-4)})` : 'there';
}

module.exports = {
  normalizePhone,
  isValidE164,
  sendWhatsAppMessage,
  sendSigningInviteWhatsApp,
  sendReminderWhatsApp,
  sendCompletionWhatsApp,
  sendDeclineWhatsApp,
  sendOtpWhatsApp,
  sendExpiryWarningWhatsApp,
  loadTemplatesFromDb,
  checkOtpSendRateLimit,
  // Expose for testing
  _renderTemplate,
  _templateCache,
};
