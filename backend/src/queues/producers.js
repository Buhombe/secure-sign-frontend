'use strict';

/**
 * queues/producers.js — HakikiSign Job Producers (v2 — with notification producers)
 *
 * CHANGES FROM v1
 * ─────────────────
 * + enqueueNotificationInvite     — WhatsApp-first signing invitation
 * + enqueueNotificationReminder   — WhatsApp-first reminder
 * + enqueueNotificationCompletion — WhatsApp-first completion notice
 * + enqueueNotificationDecline    — WhatsApp-first decline notice
 * + enqueueNotificationOtp        — WhatsApp-first OTP delivery
 * + enqueueExpiryWarnings         — schedule expiry warning sweep
 *
 * ALL EXISTING PRODUCERS ARE UNCHANGED.
 * Existing code calling enqueueSigningInvite (email queue) continues to work.
 * New code should prefer enqueueNotificationInvite for multi-channel delivery.
 *
 * MIGRATION PATH
 * ───────────────
 * Phase 1 (this release):
 *   - signerService.sendSigningEmailForOrder uses enqueueNotificationInvite
 *     which internally tries WhatsApp then falls back to email.
 *   - Old email-only producers remain available for backwards compatibility.
 *
 * Phase 2 (future):
 *   - Remove email-only producers; all notifications via notification queue.
 */

const { v4: uuidv4 } = require('uuid');
const {
  pdfQueue,
  certificateQueue,
  emailQueue,
  auditQueue,
  cryptoQueue,
  notificationQueue,
} = require('./index');

// ══════════════════════════════════════════════════════════════════════════════
// QUEUE A — PDF PROCESSING (UNCHANGED)
// ══════════════════════════════════════════════════════════════════════════════

async function enqueuePdfStamp(params) {
  const jobId = `pdfstamp:${params.documentId}:${params.signerEmail}`;
  return pdfQueue.add('stamp-pdf', params, { jobId, attempts: 3 });
}

async function enqueueFinalHashUpdate(documentId) {
  return pdfQueue.add('final-hash', { documentId }, {
    jobId: `finalhash:${documentId}`,
  });
}

// ══════════════════════════════════════════════════════════════════════════════
// QUEUE B — CERTIFICATE GENERATION (UNCHANGED)
// ══════════════════════════════════════════════════════════════════════════════

async function enqueueCertificate(documentId) {
  return certificateQueue.add(
    'generate-certificate',
    { documentId },
    { jobId: `cert:${documentId}`, attempts: 5, delay: 2_000 }
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// QUEUE C — EMAIL DELIVERY (UNCHANGED — legacy; prefer Queue F for new code)
// ══════════════════════════════════════════════════════════════════════════════

async function enqueueSigningInvite({ documentId, recipientEmail, documentName, signingLink }) {
  return emailQueue.add(
    'send-signing-invite',
    { documentId, recipientEmail, documentName, signingLink },
    { jobId: `email-invite-${documentId}-${recipientEmail}`, attempts: 7 }
  );
}

async function enqueueCompletionEmail({ documentId, ownerEmail, documentName, signerEmails }) {
  return emailQueue.add(
    'send-completion',
    { documentId, ownerEmail, documentName, signerEmails },
    { jobId: `email:complete:${documentId}`, attempts: 7 }
  );
}

async function enqueueReminderEmail({ documentId, signerEmail, documentName, signingLink, reminderNum }) {
  const jobId = `email:remind:${documentId}:${signerEmail}:${reminderNum || 1}`;
  return emailQueue.add(
    'send-reminder',
    { documentId, signerEmail, documentName, signingLink, reminderNum },
    { jobId, attempts: 5 }
  );
}

async function enqueueDeclineNotification({ documentId, signerEmail, ownerEmail, documentName, reason }) {
  return emailQueue.add(
    'send-decline-notification',
    { documentId, signerEmail, ownerEmail, documentName, reason },
    { jobId: `email:decline:${documentId}:${signerEmail}`, attempts: 5 }
  );
}

async function enqueueVerificationEmail({ userId, recipientEmail, verifyLink }) {
  return emailQueue.add(
    'send-verification',
    { userId, recipientEmail, verifyLink },
    { jobId: `email:verify:${userId}:${Date.now()}`, attempts: 5 }
  );
}

async function enqueuePasswordResetEmail({ userId, recipientEmail, resetLink }) {
  return emailQueue.add(
    'send-password-reset',
    { userId, recipientEmail, resetLink },
    { jobId: `email:pwreset:${userId}:${Date.now()}`, attempts: 5 }
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// QUEUE D — AUDIT & SECURITY (UNCHANGED)
// ══════════════════════════════════════════════════════════════════════════════

async function enqueueExpirationEnforcement() {
  const ts = new Date().toISOString().slice(0, 16);
  return auditQueue.add(
    'enforce-expirations',
    { triggeredAt: new Date().toISOString() },
    { jobId: `expire:${ts}`, attempts: 3 }
  );
}

async function enqueueCloudinaryCleanup({ publicIds, reason }) {
  return auditQueue.add(
    'cloudinary-cleanup',
    { publicIds, reason },
    { jobId: `cleanup:${uuidv4()}`, attempts: 5, backoff: { type: 'exponential', delay: 60_000 } }
  );
}

async function enqueueAuditIntegrityCheck({ documentId }) {
  return auditQueue.add(
    'audit-integrity-check',
    { documentId },
    { jobId: `auditcheck:${documentId}`, attempts: 2, delay: 5_000 }
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// QUEUE E — CRYPTO OPERATIONS (UNCHANGED)
// ══════════════════════════════════════════════════════════════════════════════

async function enqueueKeyGeneration({ userId }) {
  return cryptoQueue.add(
    'generate-rsa-keypair',
    { userId },
    { jobId: `crypto:keygen:${userId}`, priority: 10, attempts: 2 }
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// QUEUE F — MULTI-CHANNEL NOTIFICATION (NEW)
// ══════════════════════════════════════════════════════════════════════════════
//
// IDEMPOTENCY
// ────────────
// Job IDs are deterministic and content-addressed:
//   notif:invite:<documentId>:<signerId>
//   notif:remind:<documentId>:<signerId>:<N>
//   notif:complete:<documentId>
//   notif:decline:<documentId>:<signerEmail>
//   notif:otp:<documentId>:<signerId>:<timestamp-minute>
//
// Using signerId (not email) as the key component means re-invitations
// after a token reissue get a fresh job (same signerId but new token/link).
// The notification worker handles this correctly.

/**
 * enqueueNotificationInvite
 *
 * Preferred replacement for enqueueSigningInvite for WhatsApp-capable signers.
 *
 * @param {object} params
 * @param {string} params.documentId
 * @param {string} params.signerId        UUID of document_signers row
 * @param {string} params.signingLink     Full signing URL with token fragment
 */
async function enqueueNotificationInvite({ documentId, signerId, signingLink }) {
  const jobId = `notif:invite:${documentId}:${signerId}`;
  return notificationQueue.add(
    'send-signing-invite',
    { documentId, signerId, signingLink },
    {
      jobId,
      attempts: 5,
      backoff: { type: 'exponential', delay: 15_000 }, // 15s, 30s, 60s, 120s, 240s
    }
  );
}

/**
 * enqueueNotificationReminder
 *
 * @param {object} params
 * @param {string} params.documentId
 * @param {string} params.signerId
 * @param {string} params.signingLink
 * @param {number} [params.reminderNumber]  Used to generate unique job IDs for multiple reminders
 * @param {number} [params.delayMs]         Delay before processing (for scheduled reminders)
 */
async function enqueueNotificationReminder({ documentId, signerId, signingLink, reminderNumber = 1, delayMs = 0 }) {
  const jobId = `notif:remind:${documentId}:${signerId}:${reminderNumber}`;
  return notificationQueue.add(
    'send-reminder',
    { documentId, signerId, signingLink, reminderNumber },
    {
      jobId,
      attempts: 3,
      backoff:  { type: 'exponential', delay: 60_000 },
      delay:    delayMs,
    }
  );
}

/**
 * enqueueNotificationCompletion
 *
 * @param {object} params
 * @param {string} params.documentId
 * @param {string} params.ownerEmail
 * @param {string} [params.ownerPhone]   E.164 phone for WhatsApp
 * @param {string} [params.ownerName]
 * @param {string} params.documentName
 * @param {string[]} params.signerEmails
 */
async function enqueueNotificationCompletion({ documentId, ownerEmail, ownerPhone, ownerName, documentName, signerEmails }) {
  return notificationQueue.add(
    'send-completion',
    { documentId, ownerEmail, ownerPhone, ownerName, documentName, signerEmails },
    {
      jobId:    `notif:complete:${documentId}`,
      attempts: 5,
      backoff:  { type: 'exponential', delay: 15_000 },
    }
  );
}

/**
 * enqueueNotificationDecline
 */
async function enqueueNotificationDecline({ documentId, ownerEmail, ownerPhone, ownerName, documentName, signerName, signerEmail, declineReason }) {
  return notificationQueue.add(
    'send-decline',
    { documentId, ownerEmail, ownerPhone, ownerName, documentName, signerName, signerEmail, declineReason },
    {
      jobId:    `notif:decline:${documentId}:${signerEmail}`,
      attempts: 5,
      backoff:  { type: 'exponential', delay: 15_000 },
    }
  );
}

/**
 * enqueueNotificationOtp
 *
 * OTP delivery is time-sensitive — short delays, fewer retries.
 * OTPs expire in 10 min; a job retrying after 10 min is useless.
 * Max 3 attempts, 30s backoff — if all fail, user must request a new OTP.
 */
async function enqueueNotificationOtp({ documentId, signerId, otpCode, expiryMinutes = 10 }) {
  // Time-bucketed job ID: prevents duplicate sends within the same minute
  const minuteBucket = new Date().toISOString().slice(0, 16).replace(':', '-');
  const jobId = `notif:otp:${documentId}:${signerId}:${minuteBucket}`;

  return notificationQueue.add(
    'send-otp',
    { documentId, signerId, otpCode, expiryMinutes },
    {
      jobId,
      attempts: 3,
      backoff:  { type: 'exponential', delay: 30_000 }, // 30s, 60s, 120s
      timeout:  20_000,
    }
  );
}

/**
 * enqueueExpiryWarningsSweep
 *
 * Scheduled job — finds signers with tokens expiring in the next `windowHours`
 * and sends WhatsApp expiry warnings.
 */
async function enqueueExpiryWarningsSweep({ windowHours = 24 } = {}) {
  const ts = new Date().toISOString().slice(0, 13); // hour-level dedup
  return notificationQueue.add(
    'expiry-warnings-sweep',
    { windowHours },
    {
      jobId:    `notif:expiry-sweep:${ts}`,
      attempts: 2,
      backoff:  { type: 'fixed', delay: 60_000 },
    }
  );
}

module.exports = {
  // Queue A
  enqueuePdfStamp,
  enqueueFinalHashUpdate,

  // Queue B
  enqueueCertificate,

  // Queue C — email only (legacy)
  enqueueSigningInvite,
  enqueueCompletionEmail,
  enqueueReminderEmail,
  enqueueDeclineNotification,
  enqueueVerificationEmail,
  enqueuePasswordResetEmail,

  // Queue D
  enqueueExpirationEnforcement,
  enqueueCloudinaryCleanup,
  enqueueAuditIntegrityCheck,

  // Queue E
  enqueueKeyGeneration,

  // Queue F — multi-channel notifications (NEW)
  enqueueNotificationInvite,
  enqueueNotificationReminder,
  enqueueNotificationCompletion,
  enqueueNotificationDecline,
  enqueueNotificationOtp,
  enqueueExpiryWarningsSweep,
};
