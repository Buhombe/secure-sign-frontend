'use strict';

/**
 * workers/notificationWorker.js — HakikiSign Multi-Channel Notification Worker
 *
 * Processes jobs from Queue F (notification-delivery).
 *
 * WORKER DESIGN
 * ──────────────
 * Each job handler calls into the NotificationOrchestrator, which:
 *   1. Loads signer/owner context from DB
 *   2. Determines the best channel (WhatsApp or email fallback)
 *   3. Calls whatsappService or emailService
 *   4. Writes delivery state to notification_logs
 *
 * The worker itself handles:
 *   - BullMQ job lifecycle (completed/failed events)
 *   - Dead-letter logic (after all attempts exhausted)
 *   - Template pre-loading on startup
 *   - Structured logging for observability
 *
 * RETRY BEHAVIOUR
 * ────────────────
 * BullMQ retries a job if the handler throws.
 * The orchestrator throws only for TRANSIENT failures.
 * For PERMANENT WhatsApp failures, the orchestrator handles email fallback
 * internally and returns success — BullMQ never sees a failure.
 *
 * This means:
 *   - Job attempt 1: WhatsApp fails permanently → email sent → job COMPLETES
 *   - Job attempt 1: WhatsApp fails transiently → throws → BullMQ retries
 *   - Job attempt 5: All WhatsApp retries exhausted → job FAILS (dead letter)
 *
 * DEAD-LETTER HANDLING
 * ──────────────────────
 * When a job moves to 'failed' state after all attempts, the 'failed' event
 * fires. We log it to a structured error record and (future) could push to
 * an ops alert queue. The notification_log row is already marked 'failed' by
 * the orchestrator on each attempt.
 */

const { Worker } = require('bullmq');
const logger     = require('../config/logger');
const { makeRedisConnection } = require('../queues/index');
const { loadTemplatesFromDb } = require('../services/whatsappService');
const {
  orchestrateSigningInvite,
  orchestrateReminder,
  orchestrateCompletion,
  orchestrateDecline,
  orchestrateOtp,
  orchestrateExpiryWarnings,
} = require('../services/notificationOrchestrator');

// ── Job handlers ──────────────────────────────────────────────────────────────

async function handleSigningInvite(job) {
  const { documentId, signerId, signingLink } = job.data;

  logger.info('[NotifWorker] send-signing-invite started', {
    jobId: job.id, documentId, signerId,
  });

  const result = await orchestrateSigningInvite({
    documentId,
    signerId,
    signingLink,
    jobId:         job.id,
    attemptNumber: job.attemptsMade + 1,
  });

  logger.info('[NotifWorker] send-signing-invite completed', {
    jobId: job.id, documentId, signerId, ...result,
  });

  return result;
}

async function handleReminder(job) {
  const { documentId, signerId, signingLink } = job.data;

  logger.info('[NotifWorker] send-reminder started', {
    jobId: job.id, documentId, signerId,
  });

  const result = await orchestrateReminder({
    documentId,
    signerId,
    signingLink,
    jobId:         job.id,
    attemptNumber: job.attemptsMade + 1,
  });

  if (result?.suppressed) {
    logger.info('[NotifWorker] send-reminder suppressed', {
      jobId: job.id, reason: result.reason,
    });
  } else {
    logger.info('[NotifWorker] send-reminder completed', {
      jobId: job.id, documentId, signerId, ...result,
    });
  }

  return result;
}

async function handleCompletion(job) {
  const { documentId, ownerEmail, ownerPhone, ownerName, documentName, signerEmails } = job.data;

  logger.info('[NotifWorker] send-completion started', {
    jobId: job.id, documentId, ownerEmail,
  });

  const result = await orchestrateCompletion({
    documentId, ownerEmail, ownerPhone, ownerName, documentName, signerEmails,
    jobId:         job.id,
    attemptNumber: job.attemptsMade + 1,
  });

  logger.info('[NotifWorker] send-completion completed', {
    jobId: job.id, documentId, ...result,
  });

  return result;
}

async function handleDecline(job) {
  const { documentId, ownerEmail, ownerPhone, ownerName, documentName, signerName, signerEmail, declineReason } = job.data;

  logger.info('[NotifWorker] send-decline started', {
    jobId: job.id, documentId, signerEmail,
  });

  const result = await orchestrateDecline({
    documentId, ownerEmail, ownerPhone, ownerName, documentName,
    signerName, signerEmail, declineReason,
    jobId:         job.id,
    attemptNumber: job.attemptsMade + 1,
  });

  logger.info('[NotifWorker] send-decline completed', {
    jobId: job.id, documentId, ...result,
  });

  return result;
}

async function handleOtp(job) {
  const { documentId, signerId, otpCode, expiryMinutes } = job.data;

  logger.info('[NotifWorker] send-otp started', {
    jobId: job.id, documentId, signerId,
  });

  const result = await orchestrateOtp({
    documentId, signerId, otpCode, expiryMinutes,
    jobId:         job.id,
    attemptNumber: job.attemptsMade + 1,
  });

  logger.info('[NotifWorker] send-otp completed', {
    jobId: job.id, documentId, signerId, channel: result.channel,
  });

  return result;
}

async function handleExpiryWarningsSweep(job) {
  const { windowHours = 24 } = job.data;

  logger.info('[NotifWorker] expiry-warnings-sweep started', {
    jobId: job.id, windowHours,
  });

  const warned = await orchestrateExpiryWarnings(windowHours);

  logger.info('[NotifWorker] expiry-warnings-sweep completed', {
    jobId: job.id, warned: warned.length,
  });

  return { warned: warned.length };
}

// ── Custom backoff strategy ───────────────────────────────────────────────────
// BullMQ 'custom' backoff requires a settings.backoffStrategy function.
// We implement: attempt 1 → 15s, attempt 2 → 45s, attempt 3 → 120s,
//               attempt 4 → 300s, attempt 5 → 600s.
// This is more aggressive than pure exponential — WhatsApp failures during
// Twilio outages typically resolve in minutes, not hours.

function notificationBackoffStrategy(attemptsMade) {
  const delays = [15_000, 45_000, 120_000, 300_000, 600_000];
  return delays[Math.min(attemptsMade, delays.length - 1)];
}

// ── Worker factory ────────────────────────────────────────────────────────────

function createNotificationWorker() {
  const worker = new Worker(
    'notification-delivery',
    async (job) => {
      switch (job.name) {
        case 'send-signing-invite':     return handleSigningInvite(job);
        case 'send-reminder':           return handleReminder(job);
        case 'send-completion':         return handleCompletion(job);
        case 'send-decline':            return handleDecline(job);
        case 'send-otp':                return handleOtp(job);
        case 'expiry-warnings-sweep':   return handleExpiryWarningsSweep(job);
        default:
          throw new Error(`[NotifWorker] Unknown job name: ${job.name}`);
      }
    },
    {
      ...makeRedisConnection(),
      concurrency: 5,
      settings: {
        backoffStrategy: notificationBackoffStrategy,
      },
    }
  );

  // ── Event handlers ──────────────────────────────────────────────────────────

  worker.on('completed', (job, result) => {
    logger.info('[NotifWorker] Job completed', {
      jobId:   job.id,
      name:    job.name,
      attempt: job.attemptsMade,
      result,
    });
  });

  worker.on('failed', (job, err) => {
    const isFinalFailure = job?.attemptsMade >= (job?.opts?.attempts || 5);

    logger.error('[NotifWorker] Job failed', {
      jobId:        job?.id,
      name:         job?.name,
      attempt:      job?.attemptsMade,
      maxAttempts:  job?.opts?.attempts,
      isFinalFailure,
      errorMessage: err.message,
      errorCode:    err.code,
      permanent:    err.permanent,
    });

    // Dead-letter: final failure — alert operations
    if (isFinalFailure) {
      _handleDeadLetter(job, err).catch(dlErr => {
        logger.error('[NotifWorker] Dead-letter handler failed', { message: dlErr.message });
      });
    }
  });

  worker.on('error', (err) => {
    logger.error('[NotifWorker] Worker connection error', { message: err.message });
  });

  worker.on('stalled', (jobId) => {
    logger.warn('[NotifWorker] Job stalled (lock expired)', { jobId });
  });

  return worker;
}

// ── Dead-letter handling ──────────────────────────────────────────────────────

/**
 * _handleDeadLetter
 *
 * Called when a notification job exhausts all retries.
 * Currently:
 *   1. Logs a structured dead-letter event (visible in log aggregators)
 *   2. Updates any pending notification_log rows to 'undeliverable'
 *
 * Future extensions:
 *   - Push to a Slack ops channel via webhook
 *   - Enqueue to an escalation queue for manual retry
 *   - Email the document owner to retry via another channel
 */
async function _handleDeadLetter(job, err) {
  const pool = require('../config/database');

  logger.error('[NotifWorker] DEAD LETTER — notification permanently failed', {
    jobId:       job.id,
    jobName:     job.name,
    jobData:     _sanitizeForLog(job.data),
    errorCode:   err.code,
    errorMessage: err.message,
  });

  // Mark any 'pending' or 'queued' notification_logs for this job as undeliverable
  try {
    await pool.query(
      `UPDATE notification_logs
       SET status = 'undeliverable', failed_at = NOW(),
           error_code = $2, error_message = $3
       WHERE job_id = $1 AND status IN ('pending', 'queued', 'sent')`,
      [job.id, err.code || 'EXHAUSTED', err.message?.slice(0, 500)]
    );
  } catch (dbErr) {
    logger.error('[NotifWorker] Dead-letter DB update failed', { message: dbErr.message });
  }
}

/**
 * Strip sensitive fields from job data for safe log output.
 */
function _sanitizeForLog(data) {
  if (!data) return data;
  const safe = { ...data };
  delete safe.otpCode;
  if (safe.signingLink) safe.signingLink = safe.signingLink.slice(0, 50) + '…';
  return safe;
}

// ── Template warmup ───────────────────────────────────────────────────────────

/**
 * warmNotificationWorker — called once at worker startup.
 * Pre-loads WhatsApp templates from DB into memory cache.
 */
async function warmNotificationWorker() {
  await loadTemplatesFromDb();
}

module.exports = {
  createNotificationWorker,
  warmNotificationWorker,
};
