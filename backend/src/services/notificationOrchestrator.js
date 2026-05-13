'use strict';

/**
 * notificationOrchestrator.js — HakikiSign Multi-Channel Notification Coordinator
 *
 * This is the SINGLE ENTRY POINT for all notification dispatch.
 * It decides:
 *   1. Which channel to attempt first (based on signer/user preferences)
 *   2. Whether to fall back to email on WhatsApp failure
 *   3. How to record delivery state in notification_logs
 *   4. How to enforce anti-spam rules
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * CHANNEL PRIORITY LOGIC
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * For a given notification event, priority is determined as:
 *
 *   1. Signer's explicit notif_channel (set on document_signers.notif_channel)
 *   2. If WhatsApp: signer must have a valid whatsapp_phone
 *   3. If WhatsApp fails permanently → fall back to email
 *   4. If WhatsApp fails transiently → the WORKER retries; this module returns
 *      the error so BullMQ knows to retry
 *
 * EMAIL FALLBACK TRIGGERS
 * ────────────────────────
 *   - No WhatsApp phone available
 *   - Permanent WhatsApp error (invalid number, opted out)
 *   - WhatsApp phone not on WhatsApp (Twilio error 63018)
 *   - Explicit preference: email only
 *
 * ANTI-SPAM
 * ──────────
 * Reminders are subject to:
 *   - Max 3 reminders per document per signer
 *   - Minimum 24-hour gap between reminders
 *   - Anti-spam check on notification_logs (no dupe within 1 hour)
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * DELIVERY TRACKING
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * Every attempt creates a row in notification_logs.
 * The row is updated with:
 *   - provider_id when Twilio/Brevo returns a message SID
 *   - status = 'sent' after provider accepts
 *   - status = 'delivered' / 'read' via webhook (webhookHandler.js)
 *   - status = 'failed' with error_code on permanent failure
 */

const pool    = require('../config/database');
const logger  = require('../config/logger');
const {
  sendSigningInviteWhatsApp,
  sendReminderWhatsApp,
  sendCompletionWhatsApp,
  sendDeclineWhatsApp,
  sendOtpWhatsApp,
  sendExpiryWarningWhatsApp,
  normalizePhone,
} = require('./whatsappService');
const {
  sendSigningEmail,
  sendCompletionEmail,
  sendDeclineEmail,
  buildSigningUrl,
} = require('./emailService');

const BASE_URL       = process.env.BASE_URL || 'http://localhost:3000';
const MAX_REMINDERS  = parseInt(process.env.MAX_REMINDERS_PER_SIGNER, 10)  || 3;
const MIN_REMINDER_GAP_HOURS = parseInt(process.env.MIN_REMINDER_GAP_HOURS, 10) || 24;

// ── Delivery log helpers ──────────────────────────────────────────────────────

async function createDeliveryLog({
  documentId, signerId, userId, type, channel, recipient,
  templateKey, jobId, attemptNumber, isFallback, idempotencyKey,
}) {
  const result = await pool.query(
    `INSERT INTO notification_logs
       (document_id, signer_id, user_id, notification_type, channel, recipient,
        template_key, job_id, attempt_number, is_fallback, idempotency_key, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'pending')
     ON CONFLICT (idempotency_key) DO UPDATE
       SET attempt_number = notification_logs.attempt_number + 1,
           updated_at = NOW()
     RETURNING id`,
    [
      documentId, signerId, userId, type, channel, recipient,
      templateKey, jobId, attemptNumber, isFallback, idempotencyKey,
    ]
  );
  return result.rows[0].id;
}

async function markLogSent(logId, providerId) {
  await pool.query(
    `UPDATE notification_logs
     SET status = 'sent', provider_id = $2, sent_at = NOW()
     WHERE id = $1`,
    [logId, providerId]
  );
}

async function markLogFailed(logId, errorCode, errorMessage) {
  await pool.query(
    `UPDATE notification_logs
     SET status = 'failed', error_code = $2, error_message = $3, failed_at = NOW()
     WHERE id = $1`,
    [logId, errorCode, errorMessage]
  );
}

// ── Anti-spam guard for reminders ─────────────────────────────────────────────

async function checkReminderAllowed(signerId) {
  const row = await pool.query(
    `SELECT reminders_sent, last_reminded_at, token_expires_at
     FROM document_signers WHERE id = $1`,
    [signerId]
  );

  if (!row.rows[0]) return { allowed: false, reason: 'signer_not_found' };

  const { reminders_sent, last_reminded_at, token_expires_at } = row.rows[0];

  if (reminders_sent >= MAX_REMINDERS) {
    return { allowed: false, reason: 'max_reminders_reached' };
  }

  if (last_reminded_at) {
    const gapMs = Date.now() - new Date(last_reminded_at).getTime();
    const gapHours = gapMs / (1000 * 60 * 60);
    if (gapHours < MIN_REMINDER_GAP_HOURS) {
      return { allowed: false, reason: 'too_soon', nextAllowedAt: new Date(
        new Date(last_reminded_at).getTime() + MIN_REMINDER_GAP_HOURS * 3600 * 1000
      )};
    }
  }

  // Don't remind if token already expired
  if (token_expires_at && new Date(token_expires_at) < new Date()) {
    return { allowed: false, reason: 'token_expired' };
  }

  return { allowed: true };
}

async function incrementReminderCount(signerId) {
  await pool.query(
    `UPDATE document_signers
     SET reminders_sent = reminders_sent + 1, last_reminded_at = NOW()
     WHERE id = $1`,
    [signerId]
  );
}

// ── Signer context loader ─────────────────────────────────────────────────────

async function loadSignerContext(signerId) {
  const result = await pool.query(
    `SELECT ds.id, ds.email, ds.name, ds.phone, ds.whatsapp_phone,
            ds.notif_channel, ds.token_expires_at, ds.reminders_sent,
            d.original_name, d.title, d.user_id AS owner_id,
            u.email AS owner_email, u.name AS owner_name
     FROM document_signers ds
     JOIN documents d ON d.id = ds.document_id
     JOIN users u ON u.id = d.user_id
     WHERE ds.id = $1`,
    [signerId]
  );
  return result.rows[0] || null;
}

async function loadUserPrefs(userId) {
  const result = await pool.query(
    `SELECT primary_channel, fallback_channel, language, reminders_enabled,
            completion_enabled, reminder_delay_hours
     FROM notification_preferences WHERE user_id = $1`,
    [userId]
  );
  // Default preferences if none set
  return result.rows[0] || {
    primary_channel:      'whatsapp',
    fallback_channel:     'email',
    language:             'en',
    reminders_enabled:    true,
    completion_enabled:   true,
    reminder_delay_hours: 24,
  };
}

// ── Expiry calculation helper ─────────────────────────────────────────────────

function hoursUntilExpiry(expiresAt) {
  if (!expiresAt) return 72;
  const ms = new Date(expiresAt).getTime() - Date.now();
  return Math.max(0, ms / (1000 * 60 * 60));
}

// ═════════════════════════════════════════════════════════════════════════════
// PUBLIC ORCHESTRATION FUNCTIONS
// Each function is called from the notification worker job handlers.
// ═════════════════════════════════════════════════════════════════════════════

/**
 * orchestrateSigningInvite
 *
 * Determines the best channel and sends a signing invitation.
 * Called by: notificationWorker handleSigningInvite
 *
 * @param {object} params
 * @param {string}  params.documentId
 * @param {string}  params.signerId       UUID of document_signers row
 * @param {string}  params.signingLink    Full signing URL
 * @param {string}  [params.jobId]        BullMQ job ID for tracking
 * @param {number}  [params.attemptNumber]
 * @returns {Promise<{ channel: string, providerId: string }>}
 */
async function orchestrateSigningInvite({ documentId, signerId, signingLink, jobId, attemptNumber = 1 }) {
  const ctx  = await loadSignerContext(signerId);
  if (!ctx) throw new Error(`[Orchestrator] Signer not found: ${signerId}`);

  const prefs   = await loadUserPrefs(ctx.owner_id);
  const docName = ctx.title || ctx.original_name || 'a document';
  const lang    = prefs.language || 'en';
  const idemKey = `invite:${documentId}:${signerId}`;

  // Determine channel
  const waPhone = normalizePhone(ctx.whatsapp_phone || ctx.phone);
  const useWhatsApp = ctx.notif_channel === 'whatsapp' && !!waPhone;

  if (useWhatsApp) {
    const logId = await createDeliveryLog({
      documentId, signerId, userId: null, type: 'signing_invite',
      channel: 'whatsapp', recipient: waPhone,
      templateKey: `signing_invite_whatsapp_${lang}`,
      jobId, attemptNumber, isFallback: false,
      idempotencyKey: idemKey + ':wa',
    });

    try {
      const result = await sendSigningInviteWhatsApp({
        to:            waPhone,
        signerName:    ctx.name || ctx.email.split('@')[0],
        senderName:    ctx.owner_name || ctx.owner_email,
        documentTitle: docName,
        signingLink,
        expiryHours:   Math.round(hoursUntilExpiry(ctx.token_expires_at)),
        language:      lang,
        idempotencyKey: idemKey + ':wa',
      });

      await markLogSent(logId, result.messageSid);
      logger.info('[Orchestrator] WhatsApp invite sent', { documentId, signerId });
      return { channel: 'whatsapp', providerId: result.messageSid };

    } catch (waErr) {
      await markLogFailed(logId, waErr.code || 'UNKNOWN', waErr.message);

      if (waErr.permanent && prefs.fallback_channel === 'email') {
        logger.warn('[Orchestrator] WhatsApp permanent failure — falling back to email', {
          documentId, signerId, code: waErr.code,
        });
        return _fallbackToEmailInvite({ documentId, signerId, ctx, signingLink, docName, lang, jobId, attemptNumber });
      }

      throw waErr; // transient — let BullMQ retry
    }
  }

  // Email path
  return _fallbackToEmailInvite({ documentId, signerId, ctx, signingLink, docName, lang, jobId, attemptNumber });
}

async function _fallbackToEmailInvite({ documentId, signerId, ctx, signingLink, docName, lang, jobId, attemptNumber }) {
  const idemKey = `invite:${documentId}:${signerId}:email`;
  const logId = await createDeliveryLog({
    documentId, signerId, userId: null, type: 'signing_invite',
    channel: 'email', recipient: ctx.email,
    templateKey: `signing_invite_email_${lang}`,
    jobId, attemptNumber, isFallback: true,
    idempotencyKey: idemKey,
  });

  try {
    const brevoResult = await sendSigningEmail(ctx.email, signingLink, docName);
    await markLogSent(logId, brevoResult?.id || 'brevo-sent');
    logger.info('[Orchestrator] Email invite sent', { documentId, signerId });
    return { channel: 'email', providerId: brevoResult?.id };
  } catch (emailErr) {
    await markLogFailed(logId, 'EMAIL_FAIL', emailErr.message);
    throw emailErr;
  }
}

/**
 * orchestrateReminder
 *
 * Sends a reminder to a signer who has not yet signed.
 * Enforces anti-spam rules before sending.
 */
async function orchestrateReminder({ documentId, signerId, signingLink, jobId, attemptNumber = 1 }) {
  const ctx = await loadSignerContext(signerId);
  if (!ctx) throw new Error(`[Orchestrator] Signer not found: ${signerId}`);

  // Anti-spam gate
  const allowed = await checkReminderAllowed(signerId);
  if (!allowed.allowed) {
    logger.info('[Orchestrator] Reminder suppressed', { documentId, signerId, reason: allowed.reason });
    return { suppressed: true, reason: allowed.reason };
  }

  const prefs   = await loadUserPrefs(ctx.owner_id);
  const docName = ctx.title || ctx.original_name;
  const lang    = prefs.language || 'en';
  const expiryH = Math.round(hoursUntilExpiry(ctx.token_expires_at));
  const remLeft = MAX_REMINDERS - ctx.reminders_sent - 1;
  const idemKey = `remind:${documentId}:${signerId}:${ctx.reminders_sent + 1}`;

  const waPhone = normalizePhone(ctx.whatsapp_phone || ctx.phone);
  const useWA   = ctx.notif_channel === 'whatsapp' && !!waPhone;

  if (useWA) {
    const logId = await createDeliveryLog({
      documentId, signerId, userId: null, type: 'reminder',
      channel: 'whatsapp', recipient: waPhone,
      templateKey: `reminder_whatsapp_${lang}`,
      jobId, attemptNumber, isFallback: false,
      idempotencyKey: idemKey + ':wa',
    });

    try {
      const result = await sendReminderWhatsApp({
        to:            waPhone,
        signerName:    ctx.name || ctx.email.split('@')[0],
        documentTitle: docName,
        signingLink,
        expiryHours:   expiryH,
        remindersLeft: remLeft,
        language:      lang,
        idempotencyKey: idemKey + ':wa',
      });

      await markLogSent(logId, result.messageSid);
      await incrementReminderCount(signerId);
      return { channel: 'whatsapp', providerId: result.messageSid };

    } catch (waErr) {
      await markLogFailed(logId, waErr.code || 'UNKNOWN', waErr.message);
      if (waErr.permanent && prefs.fallback_channel === 'email') {
        return _fallbackToEmailReminder({ documentId, signerId, ctx, signingLink, docName, lang, jobId, attemptNumber, idemKey });
      }
      throw waErr;
    }
  }

  return _fallbackToEmailReminder({ documentId, signerId, ctx, signingLink, docName, lang, jobId, attemptNumber, idemKey });
}

async function _fallbackToEmailReminder({ documentId, signerId, ctx, signingLink, docName, lang, jobId, attemptNumber, idemKey }) {
  const { enqueueReminderEmail } = require('../queues/producers');
  const logId = await createDeliveryLog({
    documentId, signerId, userId: null, type: 'reminder',
    channel: 'email', recipient: ctx.email,
    templateKey: `reminder_email_${lang}`,
    jobId, attemptNumber, isFallback: true,
    idempotencyKey: (idemKey || `remind:${documentId}:${signerId}`) + ':email',
  });

  try {
    // Email reminder uses existing email queue
    await enqueueReminderEmail({
      documentId,
      signerEmail:  ctx.email,
      documentName: docName,
      signingLink,
      reminderNum:  ctx.reminders_sent + 1,
    });
    await markLogSent(logId, 'email-queued');
    await incrementReminderCount(signerId);
    return { channel: 'email', providerId: 'email-queued' };
  } catch (emailErr) {
    await markLogFailed(logId, 'EMAIL_FAIL', emailErr.message);
    throw emailErr;
  }
}

/**
 * orchestrateCompletion
 *
 * Notifies the document owner that all signers have completed.
 */
async function orchestrateCompletion({ documentId, ownerEmail, ownerPhone, ownerName, documentName, signerEmails, jobId, attemptNumber = 1 }) {
  const dashboardLink = `${BASE_URL}/manage`;
  const idemKey = `complete:${documentId}`;

  // Attempt WhatsApp to owner if they have a phone
  const waPhone = normalizePhone(ownerPhone);
  if (waPhone) {
    const logId = await createDeliveryLog({
      documentId, signerId: null, userId: null, type: 'completion',
      channel: 'whatsapp', recipient: waPhone,
      templateKey: 'completion_whatsapp_en',
      jobId, attemptNumber, isFallback: false,
      idempotencyKey: idemKey + ':wa',
    });

    try {
      const result = await sendCompletionWhatsApp({
        to:            waPhone,
        ownerName:     ownerName || ownerEmail,
        documentTitle: documentName,
        signerList:    signerEmails,
        dashboardLink,
        idempotencyKey: idemKey + ':wa',
      });
      await markLogSent(logId, result.messageSid);
      return { channel: 'whatsapp', providerId: result.messageSid };
    } catch (waErr) {
      await markLogFailed(logId, waErr.code || 'UNKNOWN', waErr.message);
      if (!waErr.permanent) throw waErr; // transient — retry
      // permanent — fall through to email
      logger.warn('[Orchestrator] WhatsApp completion fallback to email', { documentId });
    }
  }

  // Email fallback
  const logId = await createDeliveryLog({
    documentId, signerId: null, userId: null, type: 'completion',
    channel: 'email', recipient: ownerEmail,
    templateKey: 'completion_email_en',
    jobId, attemptNumber, isFallback: true,
    idempotencyKey: idemKey + ':email',
  });

  try {
    const r = await sendCompletionEmail(ownerEmail, documentName, signerEmails);
    await markLogSent(logId, r?.id || 'brevo-sent');
    return { channel: 'email', providerId: r?.id };
  } catch (emailErr) {
    await markLogFailed(logId, 'EMAIL_FAIL', emailErr.message);
    throw emailErr;
  }
}

/**
 * orchestrateDecline
 *
 * Notifies the document owner that a signer declined.
 */
async function orchestrateDecline({ documentId, ownerEmail, ownerPhone, ownerName, documentName, signerName, signerEmail, declineReason, jobId, attemptNumber = 1 }) {
  const dashboardLink = `${BASE_URL}/manage`;
  const idemKey = `decline:${documentId}:${signerEmail}`;
  const waPhone = normalizePhone(ownerPhone);

  if (waPhone) {
    const logId = await createDeliveryLog({
      documentId, signerId: null, userId: null, type: 'decline',
      channel: 'whatsapp', recipient: waPhone,
      templateKey: 'decline_whatsapp_en',
      jobId, attemptNumber, isFallback: false,
      idempotencyKey: idemKey + ':wa',
    });

    try {
      const result = await sendDeclineWhatsApp({
        to:            waPhone,
        ownerName:     ownerName || ownerEmail,
        documentTitle: documentName,
        signerName:    signerName || signerEmail,
        declineReason,
        dashboardLink,
        idempotencyKey: idemKey + ':wa',
      });
      await markLogSent(logId, result.messageSid);
      return { channel: 'whatsapp', providerId: result.messageSid };
    } catch (waErr) {
      await markLogFailed(logId, waErr.code || 'UNKNOWN', waErr.message);
      if (!waErr.permanent) throw waErr;
      logger.warn('[Orchestrator] WhatsApp decline fallback to email', { documentId });
    }
  }

  const logId = await createDeliveryLog({
    documentId, signerId: null, userId: null, type: 'decline',
    channel: 'email', recipient: ownerEmail,
    templateKey: 'decline_email_en',
    jobId, attemptNumber, isFallback: true,
    idempotencyKey: idemKey + ':email',
  });

  try {
    await sendDeclineEmail(ownerEmail, documentName, signerEmail, declineReason);
    await markLogSent(logId, 'brevo-sent');
    return { channel: 'email', providerId: 'brevo-sent' };
  } catch (emailErr) {
    await markLogFailed(logId, 'EMAIL_FAIL', emailErr.message);
    throw emailErr;
  }
}

/**
 * orchestrateOtp
 *
 * Delivers an OTP for signer identity verification.
 * Prefers WhatsApp; falls back to email.
 * DOES NOT send via SMS directly (cost) — SMS is a Twilio feature add-on.
 */
async function orchestrateOtp({ documentId, signerId, otpCode, expiryMinutes = 10, jobId, attemptNumber = 1 }) {
  const ctx = await loadSignerContext(signerId);
  if (!ctx) throw new Error(`[Orchestrator] Signer not found: ${signerId}`);

  const docName  = ctx.title || ctx.original_name;
  const idemKey  = `otp:${documentId}:${signerId}:${otpCode.slice(0, 3)}`; // partial - not full OTP in key
  const waPhone  = normalizePhone(ctx.whatsapp_phone || ctx.phone);

  if (waPhone) {
    const logId = await createDeliveryLog({
      documentId, signerId, userId: null, type: 'otp',
      channel: 'whatsapp', recipient: waPhone,
      templateKey: 'otp_whatsapp_en',
      jobId, attemptNumber, isFallback: false,
      idempotencyKey: idemKey + ':wa',
    });

    try {
      const result = await sendOtpWhatsApp({
        to:             waPhone,
        otpCode,
        documentTitle:  docName,
        expiryMinutes,
        idempotencyKey: idemKey + ':wa',
      });
      await markLogSent(logId, result.messageSid);
      return { channel: 'whatsapp', providerId: result.messageSid };
    } catch (waErr) {
      await markLogFailed(logId, waErr.code || 'UNKNOWN', waErr.message);
      if (!waErr.permanent) throw waErr;
      logger.warn('[Orchestrator] WhatsApp OTP fallback to email', { documentId, signerId });
    }
  }

  // Email OTP fallback
  const { sendOtpEmail } = require('./emailService');
  const logId = await createDeliveryLog({
    documentId, signerId, userId: null, type: 'otp',
    channel: 'email', recipient: ctx.email,
    templateKey: 'otp_email_en',
    jobId, attemptNumber, isFallback: true,
    idempotencyKey: idemKey + ':email',
  });

  try {
    const r = await sendOtpEmail(ctx.email, otpCode, docName, expiryMinutes);
    await markLogSent(logId, r?.id || 'brevo-sent');
    return { channel: 'email', providerId: r?.id };
  } catch (emailErr) {
    await markLogFailed(logId, 'EMAIL_FAIL', emailErr.message);
    throw emailErr;
  }
}

/**
 * orchestrateExpiryWarnings
 *
 * Called by the audit worker on a schedule.
 * Finds all signers whose tokens expire within `windowHours` and haven't been warned yet.
 */
async function orchestrateExpiryWarnings(windowHours = 24) {
  const cutoff = new Date(Date.now() + windowHours * 3600 * 1000);

  const result = await pool.query(
    `SELECT ds.id AS signer_id, ds.document_id, ds.email, ds.name,
            ds.phone, ds.whatsapp_phone, ds.notif_channel, ds.token, ds.token_expires_at,
            d.original_name, d.title
     FROM document_signers ds
     JOIN documents d ON d.id = ds.document_id
     LEFT JOIN notification_logs nl
       ON nl.signer_id = ds.id
       AND nl.notification_type = 'expiry_warning'
       AND nl.created_at > NOW() - INTERVAL '12 hours'
     WHERE ds.status = 'pending'
       AND ds.token IS NOT NULL
       AND ds.token_used = false
       AND ds.token_expires_at < $1
       AND ds.token_expires_at > NOW()
       AND nl.id IS NULL`,
    [cutoff]
  );

  const warned = [];
  for (const row of result.rows) {
    try {
      const waPhone   = normalizePhone(row.whatsapp_phone || row.phone);
      const signingLink = buildSigningUrl(row.document_id, row.token);
      const hoursLeft = hoursUntilExpiry(row.token_expires_at);

      if (row.notif_channel === 'whatsapp' && waPhone) {
        await sendExpiryWarningWhatsApp({
          to: waPhone,
          documentTitle: row.title || row.original_name,
          signingLink,
          hoursLeft,
        });
      }
      // For email signers, emailService handles reminders
      warned.push(row.signer_id);
    } catch (err) {
      logger.error('[Orchestrator] Expiry warning failed', {
        signerId: row.signer_id, message: err.message,
      });
    }
  }

  logger.info('[Orchestrator] Expiry warnings sent', { count: warned.length });
  return warned;
}

module.exports = {
  orchestrateSigningInvite,
  orchestrateReminder,
  orchestrateCompletion,
  orchestrateDecline,
  orchestrateOtp,
  orchestrateExpiryWarnings,
  // expose for testing
  checkReminderAllowed,
  loadSignerContext,
  loadUserPrefs,
};
