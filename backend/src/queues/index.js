'use strict';

/**
 * queues/index.js — HakikiSign BullMQ Queue Registry (v2 — with notification queue)
 *
 * CHANGES FROM v1
 * ─────────────────
 * + notificationQueue (Queue F) — dedicated WhatsApp/multi-channel notification delivery
 *
 * WHY A SEPARATE NOTIFICATION QUEUE?
 * ─────────────────────────────────────
 * The existing emailQueue handles only Brevo email delivery.
 * The new notificationQueue handles:
 *   1. Channel selection logic (WhatsApp vs email fallback)
 *   2. WhatsApp-specific retry behaviour (immediate fallback on permanent errors)
 *   3. Delivery state tracking in notification_logs
 *   4. Anti-spam coordination for reminders
 *
 * Keeping these separate means:
 *   - Email retries (7 attempts, ~10min backoff) don't affect WhatsApp retry policy
 *   - WhatsApp-specific concurrency can be tuned (Twilio rate limits)
 *   - Notification analytics are isolated to one queue for dashboards
 *
 * ALL OTHER QUEUES ARE UNCHANGED.
 * This file is a DROP-IN REPLACEMENT for the original queues/index.js.
 */

const { Queue } = require('bullmq');
const logger    = require('../config/logger');

function makeRedisConnection() {
  const url = process.env.REDIS_URL;
  if (!url) {
    logger.warn('[Queues] REDIS_URL not set — BullMQ will not function');
  }
  return url
    ? { connection: { url } }
    : { connection: { host: 'localhost', port: 6379 } };
}

const BASE_JOB_OPTS = {
  removeOnComplete: { count: 500 },
  removeOnFail:     { count: 1000 },
};

// ── Queue: PDF Processing ─────────────────────────────────────────────────────
const pdfQueue = new Queue('pdf-processing', {
  ...makeRedisConnection(),
  defaultJobOptions: {
    ...BASE_JOB_OPTS,
    attempts: 3,
    backoff:  { type: 'exponential', delay: 5_000 },
    timeout:  120_000,
  },
});

// ── Queue: Certificate Generation ────────────────────────────────────────────
const certificateQueue = new Queue('certificate-gen', {
  ...makeRedisConnection(),
  defaultJobOptions: {
    ...BASE_JOB_OPTS,
    attempts: 5,
    backoff:  { type: 'exponential', delay: 3_000 },
    timeout:  60_000,
  },
});

// ── Queue: Email Delivery (UNCHANGED — Brevo/email only) ──────────────────────
const emailQueue = new Queue('email-delivery', {
  ...makeRedisConnection(),
  defaultJobOptions: {
    ...BASE_JOB_OPTS,
    attempts: 7,
    backoff:  { type: 'exponential', delay: 10_000 },
    timeout:  30_000,
  },
});

// ── Queue: Audit & Security ───────────────────────────────────────────────────
const auditQueue = new Queue('audit-security', {
  ...makeRedisConnection(),
  defaultJobOptions: {
    ...BASE_JOB_OPTS,
    attempts: 3,
    backoff:  { type: 'exponential', delay: 30_000 },
    timeout:  300_000,
  },
});

// ── Queue: Crypto Operations ──────────────────────────────────────────────────
const cryptoQueue = new Queue('crypto-ops', {
  ...makeRedisConnection(),
  defaultJobOptions: {
    ...BASE_JOB_OPTS,
    attempts: 2,
    backoff:  { type: 'fixed', delay: 2_000 },
    timeout:  30_000,
    priority: 10,
  },
});

// ── Queue F: Multi-Channel Notification (NEW) ─────────────────────────────────
//
// RETRY POLICY DESIGN
// ────────────────────
// WhatsApp delivery can fail for two reasons:
//   a) Transient (Twilio 429, network): retry with backoff → 5 attempts
//   b) Permanent (invalid phone, opted out): the orchestrator detects this
//      and falls back to email within the SAME job attempt. No BullMQ retry needed.
//
// This means 5 BullMQ attempts is sufficient; permanent failures auto-fallback
// to email on attempt 1 before BullMQ even sees a failure.
//
// CONCURRENCY = 5
// ────────────────
// Twilio's WhatsApp API enforces 1 message/second per sender number by default.
// With concurrency=5 and typical message send times of ~300ms, throughput
// is ~3-4 msg/sec — within limits for the sandbox and basic Business plans.
// Upgrade Twilio tier and raise concurrency for higher volume.
const notificationQueue = new Queue('notification-delivery', {
  ...makeRedisConnection(),
  defaultJobOptions: {
    ...BASE_JOB_OPTS,
    attempts: 5,
    backoff: {
      type: 'custom',
      // Custom: immediate retry for first failure (likely transient);
      // exponential from attempt 2 onward
    },
    timeout: 45_000,
  },
});

// ── Queue health logging ──────────────────────────────────────────────────────
[
  { name: 'pdf-processing',       q: pdfQueue },
  { name: 'certificate-gen',      q: certificateQueue },
  { name: 'email-delivery',       q: emailQueue },
  { name: 'audit-security',       q: auditQueue },
  { name: 'crypto-ops',           q: cryptoQueue },
  { name: 'notification-delivery', q: notificationQueue },
].forEach(({ name, q }) => {
  q.on('error', (err) => {
    logger.error(`[Queue:${name}] Error`, { message: err.message });
  });
});

// ── Graceful shutdown ─────────────────────────────────────────────────────────
async function closeQueues() {
  logger.info('[Queues] Closing all queue connections');
  await Promise.allSettled([
    pdfQueue.close(),
    certificateQueue.close(),
    emailQueue.close(),
    auditQueue.close(),
    cryptoQueue.close(),
    notificationQueue.close(),
  ]);
  logger.info('[Queues] All queues closed');
}

module.exports = {
  pdfQueue,
  certificateQueue,
  emailQueue,
  auditQueue,
  cryptoQueue,
  notificationQueue,
  makeRedisConnection,
  closeQueues,
};
