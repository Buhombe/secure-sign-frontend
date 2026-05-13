'use strict';

/**
 * services/signerService.js — HakikiSign Signer Workflow Service (v2)
 *
 * CHANGES FROM v1
 * ─────────────────
 * + sendSigningEmailForOrder now uses enqueueNotificationInvite (WhatsApp-first)
 *   instead of enqueueSigningInvite (email-only).
 *   Falls back to email automatically via the orchestrator.
 *
 * + markSignedAndNotifyNext now uses enqueueNotificationCompletion for
 *   completion notice — owner gets WhatsApp if phone is available.
 *
 * + markSignedAndNotifyNext uses enqueueNotificationInvite for next signer.
 *
 * ALL DB LOGIC, TOKEN HANDLING, AND WORKFLOW PROGRESSION IS UNCHANGED.
 * Signing audit integrity is preserved exactly.
 */

const crypto   = require('crypto');
const pool     = require('../config/database');
const logger   = require('../config/logger');
const {
  enqueueNotificationInvite,
  enqueueNotificationCompletion,
  // Legacy email producers kept for backward compatibility
  enqueueSigningInvite,
  enqueueCompletionEmail,
  enqueueReminderEmail,
} = require('../queues/producers');
const { buildSigningUrl } = require('./emailService');

// ── Token hashing ─────────────────────────────────────────────────────────────

function hashToken(raw) {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

// ── Issue a signing token ─────────────────────────────────────────────────────

async function issueSignerToken(documentId, signerEmail) {
  const rawToken    = crypto.randomBytes(48).toString('hex');
  const tokenHash   = hashToken(rawToken);
  const expiryHours = parseInt(process.env.RECIPIENT_TOKEN_EXPIRY_HOURS, 10) || 72;
  const expiresAt   = new Date(Date.now() + expiryHours * 3600 * 1000);

  await pool.query(
    `UPDATE document_signers
     SET token            = $1,
         token_used       = FALSE,
         token_expires_at = $2
     WHERE document_id = $3 AND email = $4`,
    [tokenHash, expiresAt, documentId, signerEmail]
  );

  return { rawToken, expiresAt };
}

// ── Validate signer token ────────────────────────────────────────────────────

async function validateSignerToken(documentId, rawToken) {
  const tokenHash = hashToken(rawToken);

  const result = await pool.query(
    `SELECT id, email, name, status, token_expires_at, token_used, otp_required
     FROM document_signers
     WHERE document_id = $1 AND token = $2`,
    [documentId, tokenHash]
  );

  if (result.rows.length === 0) return { valid: false, reason: 'not_found' };

  const signer = result.rows[0];

  if (signer.token_used)                                         return { valid: false, reason: 'token_used' };
  if (new Date(signer.token_expires_at) < new Date())           return { valid: false, reason: 'token_expired' };
  if (signer.status === 'signed')                               return { valid: false, reason: 'already_signed' };
  if (!['pending', 'active'].includes(signer.status))           return { valid: false, reason: 'invalid_status' };

  return { valid: true, signer };
}

// ── Validate authenticated (logged-in) signer ─────────────────────────────────

async function validateAuthenticatedSigner(documentId, userEmail) {
  const result = await pool.query(
    `SELECT id, email, name, status, otp_required
     FROM document_signers
     WHERE document_id = $1 AND email = $2`,
    [documentId, userEmail]
  );

  if (result.rows.length === 0) return { valid: false, reason: 'not_a_signer' };

  const signer = result.rows[0];
  if (signer.status === 'signed') return { valid: false, reason: 'already_signed' };

  return { valid: true, signer };
}

// ── Get all signers for a document ────────────────────────────────────────────

async function getDocumentSigners(documentId) {
  const result = await pool.query(
    `SELECT id, email, name, phone, whatsapp_phone, notif_channel,
            order_num, status, signed_at, declined_at, decline_reason,
            reminders_sent, last_reminded_at
     FROM document_signers
     WHERE document_id = $1
     ORDER BY order_num ASC`,
    [documentId]
  );
  return result.rows;
}

// ── Send invite to signer at order position ───────────────────────────────────
//
// CHANGED: Now uses enqueueNotificationInvite (WhatsApp-first + email fallback)
// instead of enqueueSigningInvite (email-only).
//
// The notification queue worker (notificationWorker.js) will:
//   1. Load signer context (phone, notif_channel, language prefs)
//   2. Try WhatsApp if phone is available and notif_channel = 'whatsapp'
//   3. Fall back to email on permanent WhatsApp failure
//   4. Record delivery state in notification_logs
//
// No change to token issuance or signing link construction.

async function sendSigningEmailForOrder(documentId, orderNum, documentName) {
  const result = await pool.query(
    `SELECT id, email, phone, whatsapp_phone, notif_channel
     FROM document_signers
     WHERE document_id = $1 AND order_num = $2`,
    [documentId, orderNum]
  );

  const signer = result.rows[0];
  if (!signer) throw new Error(`No signer found at order ${orderNum} for document ${documentId}`);

  const { rawToken } = await issueSignerToken(documentId, signer.email);
  const signingLink  = buildSigningUrl(documentId, rawToken);

  // Use notification queue (WhatsApp-first) if signer has a phone set
  // Fall back to email-only queue if no phone (no regression for email-only signers)
  if (signer.whatsapp_phone || signer.phone) {
    await enqueueNotificationInvite({
      documentId,
      signerId:   signer.id,
      signingLink,
    });
  } else {
    // Email-only path (legacy; no regression)
    await enqueueSigningInvite({
      documentId,
      recipientEmail: signer.email,
      documentName:   documentName || 'a document',
      signingLink,
    });
  }

  logger.info('[signerService] Signing invite enqueued', {
    documentId,
    signerEmail: signer.email,
    channel: (signer.whatsapp_phone || signer.phone) ? 'notification-queue' : 'email-queue',
  });

  return { signerEmail: signer.email, signingLink };
}

// ── Advance workflow: mark signed and notify next ────────────────────────────
//
// CHANGED:
//   - Completion notification now tries WhatsApp (enqueueNotificationCompletion)
//   - Next-signer invite now tries WhatsApp (enqueueNotificationInvite)
//
// UNCHANGED:
//   - DB transaction (BEGIN/COMMIT/ROLLBACK)
//   - Signer status updates
//   - Document completion marking
//   - Audit trail
//   - Response timing (async enqueue)

async function markSignedAndNotifyNext(documentId, signerEmail, documentName) {
  const client = await pool.connect();
  let nextOrder = null;
  let complete  = false;

  try {
    await client.query('BEGIN');

    // Mark this signer as signed
    await client.query(
      `UPDATE document_signers
       SET status    = 'signed',
           signed_at = NOW(),
           token_used = TRUE
       WHERE document_id = $1 AND email = $2`,
      [documentId, signerEmail]
    );

    // Check for next pending signer
    const nextResult = await client.query(
      `SELECT order_num FROM document_signers
       WHERE document_id = $1 AND status = 'pending'
       ORDER BY order_num ASC
       LIMIT 1`,
      [documentId]
    );

    if (nextResult.rows.length > 0) {
      nextOrder = nextResult.rows[0].order_num;
    } else {
      // All signers have signed — mark document complete
      await client.query(
        `UPDATE documents
         SET status = 'signed', completed_at = NOW()
         WHERE id = $1`,
        [documentId]
      );
      complete = true;
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    client.release();
    throw err;
  }

  client.release();

  // ── Post-commit notifications (async, non-blocking) ──────────────────────
  //
  // HTTP response is returned BEFORE these complete.
  // If enqueueing fails, signing is already recorded permanently in DB.

  if (complete) {
    // Load owner context for WhatsApp delivery
    _enqueueCompletionNotification(documentId, documentName, signerEmail).catch(err =>
      logger.error('[signerService] Failed to enqueue completion notification', {
        documentId, message: err.message,
      })
    );
  }

  if (nextOrder !== null) {
    sendSigningEmailForOrder(documentId, nextOrder, documentName).catch(err =>
      logger.error('[signerService] Failed to enqueue next-signer invite', {
        documentId, nextOrder, message: err.message,
      })
    );
  }

  return { complete, nextOrder };
}

/**
 * _enqueueCompletionNotification
 *
 * Internal helper that loads owner context and enqueues a WhatsApp-first
 * completion notification.
 */
async function _enqueueCompletionNotification(documentId, documentName, lastSignerEmail) {
  // Load owner context
  const ownerResult = await pool.query(
    `SELECT u.id, u.email, u.name,
            np.primary_channel
     FROM documents d
     JOIN users u ON u.id = d.user_id
     LEFT JOIN notification_preferences np ON np.user_id = u.id
     WHERE d.id = $1`,
    [documentId]
  );

  if (ownerResult.rows.length === 0) return;

  const owner = ownerResult.rows[0];

  // Get all signer emails for completion notice body
  const signersResult = await pool.query(
    `SELECT email, name FROM document_signers
     WHERE document_id = $1 AND status = 'signed'
     ORDER BY order_num ASC`,
    [documentId]
  );

  const signerEmails = signersResult.rows.map(s => s.name || s.email);

  // Try to get owner's phone from their signer record or profile
  // (owner may not have a phone in users table yet — that's a future profile field)
  // For now, use notification queue which checks notification_preferences
  await enqueueNotificationCompletion({
    documentId,
    ownerEmail:   owner.email,
    ownerPhone:   null,     // future: load from user profile
    ownerName:    owner.name || owner.email,
    documentName: documentName || 'your document',
    signerEmails,
  });
}

module.exports = {
  issueSignerToken,
  validateSignerToken,
  validateAuthenticatedSigner,
  getDocumentSigners,
  sendSigningEmailForOrder,
  markSignedAndNotifyNext,
};
