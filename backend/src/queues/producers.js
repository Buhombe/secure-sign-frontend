'use strict';

/**
 * queues/producers.js — HakikiSign Job Producers
 *
 * All job enqueue calls go through this module.
 *
 * IDEMPOTENCY STRATEGY
 * ─────────────────────
 * BullMQ supports job IDs. When a job with a given ID already exists in the
 * queue (waiting or active), adding it again is a no-op. We use deterministic
 * IDs based on the document/entity being processed so that:
 *   1. Network retries from the API layer don't enqueue duplicate jobs
 *   2. Railway restart mid-enqueue doesn't create two certificate jobs for
 *      the same document
 *   3. Dead-letter jobs can be replayed safely
 *
 * ID format: `<jobType>:<entityId>[:<extra>]`
 * Examples:
 *   cert:550e8400-e29b-41d4-a716-446655440000
 *   email:invite:doc123:signer@example.com
 *   crypto:keygen:user456
 *
 * CALLER CONTRACT
 * ────────────────
 * Every producer returns the BullMQ Job object (or throws).
 * Callers in route handlers should catch errors and decide whether to:
 *   - Return 500 (job is critical, cannot proceed without it)
 *   - Return success with a warning flag (job is best-effort, e.g. email)
 *
 * The signing routes use the pattern:
 *   - DB transaction commits FIRST (signing is permanent)
 *   - Then enqueue PDF + certificate + email jobs
 *   - If enqueue fails, signing is already recorded — jobs can be manually
 *     re-enqueued via admin tools or a future retry dashboard
 */

const { v4: uuidv4 } = require('uuid');
const {
  pdfQueue,
  certificateQueue,
  emailQueue,
  auditQueue,
  cryptoQueue,
} = require('./index');

// ══════════════════════════════════════════════════════════════════════════════
// QUEUE A — PDF PROCESSING
// ══════════════════════════════════════════════════════════════════════════════

/**
 * enqueuePdfStamp — stamp a signed document with signature overlay.
 * Called AFTER the DB transaction commits with the signed state.
 *
 * @param {object} params
 * @param {string} params.documentId
 * @param {string} params.signerEmail
 * @param {string} params.signatureData   — base64 PNG data URI
 * @param {number} params.sigX
 * @param {number} params.sigY
 * @param {number} params.sigWidth
 * @param {number} params.sigHeight
 * @param {number} params.pageNumber
 * @param {string} params.encryptedPrivateKey
 * @param {string} params.publicKeyPem
 * @param {string} params.filePath        — Cloudinary URL of current PDF
 * @param {string} params.userId
 * @param {string} params.correlationId   — ties this job to the signing event
 */
async function enqueuePdfStamp(params) {
  const jobId = `pdfstamp:${params.documentId}:${params.signerEmail}`;
  return pdfQueue.add('stamp-pdf', params, {
    jobId,
    // Override attempts for PDF — 3 is sufficient; more risks double-stamping
    // if idempotency check fails on the worker side.
    attempts: 3,
  });
}

/**
 * enqueueFinalHashUpdate — after all stamps, compute and store the final PDF hash.
 */
async function enqueueFinalHashUpdate(documentId) {
  return pdfQueue.add('final-hash', { documentId }, {
    jobId: `finalhash:${documentId}`,
  });
}

// ══════════════════════════════════════════════════════════════════════════════
// QUEUE B — CERTIFICATE GENERATION
// ══════════════════════════════════════════════════════════════════════════════

/**
 * enqueueCertificate — generate certificate of completion.
 * Idempotent: uses documentId as job ID so duplicate calls are safe.
 */
async function enqueueCertificate(documentId) {
  return certificateQueue.add(
    'generate-certificate',
    { documentId },
    {
      jobId:    `cert:${documentId}`,
      attempts: 5,
      // Delay 2 seconds — give the PDF stamp job time to complete first.
      // In production you'd use job dependencies (BullMQ Pro) or a delay.
      delay:    2_000,
    }
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// QUEUE C — EMAIL DELIVERY
// ══════════════════════════════════════════════════════════════════════════════

/**
 * enqueueSigningInvite — send signing invite email to a specific signer.
 */
async function enqueueSigningInvite({ documentId, recipientEmail, documentName, signingLink }) {
  const dedupeKey = `email:invite:${documentId}:${recipientEmail}`;
  return emailQueue.add(
    'send-signing-invite',
    { documentId, recipientEmail, documentName, signingLink },
    {
      jobId:    dedupeKey,
      attempts: 7,
    }
  );
}

/**
 * enqueueCompletionEmail — notify document owner that all parties signed.
 */
async function enqueueCompletionEmail({ documentId, ownerEmail, documentName, signerEmails }) {
  return emailQueue.add(
    'send-completion',
    { documentId, ownerEmail, documentName, signerEmails },
    {
      jobId:    `email:complete:${documentId}`,
      attempts: 7,
    }
  );
}

/**
 * enqueueReminderEmail — send reminder to a signer who hasn't signed yet.
 */
async function enqueueReminderEmail({ documentId, signerEmail, documentName, signingLink, reminderNum }) {
  // Include reminderNum so multiple reminders for the same document+signer
  // are not deduplicated.
  const jobId = `email:remind:${documentId}:${signerEmail}:${reminderNum || 1}`;
  return emailQueue.add(
    'send-reminder',
    { documentId, signerEmail, documentName, signingLink, reminderNum },
    { jobId, attempts: 5 }
  );
}

/**
 * enqueueDeclineNotification — notify owner that a signer declined.
 */
async function enqueueDeclineNotification({ documentId, signerEmail, ownerEmail, documentName, reason }) {
  return emailQueue.add(
    'send-decline-notification',
    { documentId, signerEmail, ownerEmail, documentName, reason },
    {
      jobId:    `email:decline:${documentId}:${signerEmail}`,
      attempts: 5,
    }
  );
}

/**
 * enqueueVerificationEmail — send account activation email.
 * NOT deduplicated by jobId — user may request multiple times.
 */
async function enqueueVerificationEmail({ userId, recipientEmail, verifyLink }) {
  return emailQueue.add(
    'send-verification',
    { userId, recipientEmail, verifyLink },
    {
      // Use timestamp to allow multiple resends
      jobId:    `email:verify:${userId}:${Date.now()}`,
      attempts: 5,
    }
  );
}

/**
 * enqueuePasswordResetEmail
 */
async function enqueuePasswordResetEmail({ userId, recipientEmail, resetLink }) {
  return emailQueue.add(
    'send-password-reset',
    { userId, recipientEmail, resetLink },
    {
      jobId:    `email:pwreset:${userId}:${Date.now()}`,
      attempts: 5,
    }
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// QUEUE D — AUDIT & SECURITY
// ══════════════════════════════════════════════════════════════════════════════

/**
 * enqueueExpirationEnforcement — mark documents/tokens past their expiry as expired.
 * Called on a schedule from worker.js.
 */
async function enqueueExpirationEnforcement() {
  const ts = new Date().toISOString().slice(0, 16); // minute-level dedup
  return auditQueue.add(
    'enforce-expirations',
    { triggeredAt: new Date().toISOString() },
    { jobId: `expire:${ts}`, attempts: 3 }
  );
}

/**
 * enqueueCloudinaryCleanup — delete orphaned Cloudinary resources.
 */
async function enqueueCloudinaryCleanup({ publicIds, reason }) {
  return auditQueue.add(
    'cloudinary-cleanup',
    { publicIds, reason },
    {
      jobId:    `cleanup:${uuidv4()}`,
      attempts: 5,
      backoff:  { type: 'exponential', delay: 60_000 }, // 1min, 2min, 4min...
    }
  );
}

/**
 * enqueueAuditIntegrityCheck — verify HMAC hashes on audit_logs rows.
 */
async function enqueueAuditIntegrityCheck({ documentId }) {
  return auditQueue.add(
    'audit-integrity-check',
    { documentId },
    {
      jobId:    `auditcheck:${documentId}`,
      attempts: 2,
      delay:    5_000, // slight delay after signing completes
    }
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// QUEUE E — CRYPTO OPERATIONS
// ══════════════════════════════════════════════════════════════════════════════

/**
 * enqueueKeyGeneration — generate RSA-2048 key pair for a user.
 *
 * WHY QUEUE THIS?
 * RSA-2048 key generation blocks the Node.js event loop for ~200-400ms.
 * Under load (10 concurrent signings), this adds 2-4 seconds of blocked I/O
 * for all other requests. Workers run in a separate process with their own
 * event loop — no impact on API latency.
 *
 * The calling route should:
 *   1. Check if user already has keys (fast DB read)
 *   2. If not, enqueue this job and return a 202 Accepted with jobId
 *   3. Frontend polls GET /api/auth/keygen-status/:jobId
 *   4. Worker stores the generated keys in the DB when done
 *
 * For the EXISTING flow (sign immediately), we use a SYNCHRONOUS fallback:
 * if user has no keys at sign time, we generate synchronously (current
 * behaviour) and also store the keys. This preserves backwards compatibility.
 * The async path is opt-in for the future pre-generation flow.
 */
async function enqueueKeyGeneration({ userId }) {
  return cryptoQueue.add(
    'generate-rsa-keypair',
    { userId },
    {
      jobId:    `crypto:keygen:${userId}`,
      priority: 10, // high priority — user may be waiting
      attempts: 2,
    }
  );
}

module.exports = {
  // Queue A
  enqueuePdfStamp,
  enqueueFinalHashUpdate,

  // Queue B
  enqueueCertificate,

  // Queue C
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
};
