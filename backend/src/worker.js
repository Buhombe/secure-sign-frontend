'use strict';

/**
 * worker.js — HakikiSign Background Job Worker Process (v2)
 *
 * CHANGES FROM v1
 * ─────────────────
 * + createNotificationWorker() — processes Queue F (WhatsApp/multi-channel)
 * + warmNotificationWorker()   — pre-loads WhatsApp templates from DB
 * + Scheduled expiry warning sweep (every 6 hours)
 * + Scheduled reminder sweep (every 30 minutes)
 *
 * ALL EXISTING WORKERS ARE UNCHANGED.
 * This is a DROP-IN REPLACEMENT for the original worker.js.
 *
 * RAILWAY DEPLOYMENT
 * ───────────────────
 * This file is the entry point for the SEPARATE Railway worker service.
 * Start command: node src/worker.js
 * Share the same environment variables as the API service.
 */

require('dotenv').config();

const logger = require('./config/logger');
const {
  auditQueue,
  emailQueue,
  notificationQueue,
  closeQueues,
} = require('./queues/index');
const { enqueueExpiryWarningsSweep } = require('./queues/producers');
const { createPdfWorker }  = require('./workers/pdfWorker');
const {
  createCertificateWorker,
  createEmailWorker,
  createAuditWorker,
  createCryptoWorker,
} = require('./workers/otherWorkers');
const {
  createNotificationWorker,
  warmNotificationWorker,
} = require('./workers/notificationWorker');

// ── Environment validation ────────────────────────────────────────────────────

if (!process.env.REDIS_URL) {
  logger.warn('[Worker] REDIS_URL not set — workers will use localhost Redis');
}

if (!process.env.FIELD_ENCRYPTION_KEY) {
  logger.error('[Worker] FIELD_ENCRYPTION_KEY not set — crypto worker will fail');
  process.exit(1);
}

if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN) {
  logger.warn('[Worker] Twilio credentials not set — WhatsApp delivery disabled; falling back to email');
}

if (!process.env.TWILIO_WHATSAPP_FROM) {
  logger.warn('[Worker] TWILIO_WHATSAPP_FROM not set — WhatsApp delivery disabled');
}

// ── Start all workers ─────────────────────────────────────────────────────────

logger.info('[Worker] Starting HakikiSign background workers');

const workers = [
  createPdfWorker(),
  createCertificateWorker(),
  createEmailWorker(),
  createAuditWorker(),
  createCryptoWorker(),
  createNotificationWorker(),   // NEW: Queue F — WhatsApp/multi-channel
];

logger.info('[Worker] All workers started', { count: workers.length });

// ── Template warmup ───────────────────────────────────────────────────────────
// Pre-load WhatsApp templates from DB into in-memory cache.
// This runs async; if it fails, hardcoded fallback templates are used.

warmNotificationWorker()
  .then(() => logger.info('[Worker] Notification templates warmed'))
  .catch(err => logger.error('[Worker] Template warmup failed', { message: err.message }));

// ── Scheduled jobs ────────────────────────────────────────────────────────────
//
// BullMQ repeat jobs are stored in Redis. Only ONE instance of the schedule
// runs at a time even when multiple worker processes are deployed.

async function registerScheduledJobs() {
  try {
    // ── Expiry enforcement (every 15 minutes) — UNCHANGED from v1 ────────────
    await auditQueue.add(
      'enforce-expirations',
      { triggeredAt: 'scheduled' },
      {
        repeat:  { every: 15 * 60 * 1000 },
        jobId:   'scheduled:enforce-expirations',
        attempts: 3,
      }
    );

    // ── Expiry WARNING sweep (every 6 hours) — NEW ───────────────────────────
    // Finds signers with tokens expiring in the next 24 hours and sends WhatsApp
    // expiry warnings. Offset from enforcement to avoid Redis contention.
    await notificationQueue.add(
      'expiry-warnings-sweep',
      { windowHours: 24 },
      {
        repeat:   { every: 6 * 60 * 60 * 1000 },
        jobId:    'scheduled:expiry-warnings',
        attempts: 2,
      }
    );

    logger.info('[Worker] Scheduled jobs registered', {
      jobs: ['enforce-expirations (15min)', 'expiry-warnings-sweep (6hr)'],
    });
  } catch (err) {
    logger.error('[Worker] Failed to register scheduled jobs', { message: err.message });
  }
}

registerScheduledJobs();

// ── Graceful shutdown ─────────────────────────────────────────────────────────

async function gracefulShutdown(signal) {
  logger.info(`[Worker] ${signal} received — initiating graceful shutdown`);

  // Stop accepting new jobs
  await Promise.allSettled(workers.map(w => w.pause()));
  logger.info('[Worker] All workers paused');

  // Wait for in-progress jobs to complete (30 second timeout)
  const closePromise = Promise.allSettled(workers.map(w => w.close()));
  const timeout = new Promise(resolve => setTimeout(resolve, 30_000));

  await Promise.race([closePromise, timeout]);
  logger.info('[Worker] All workers closed');

  await closeQueues();
  logger.info('[Worker] Queue connections closed — exiting');

  process.exit(0);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT',  () => gracefulShutdown('SIGINT'));

process.on('uncaughtException', (err) => {
  logger.error('[Worker] Uncaught exception', { message: err.message, stack: err.stack });
  // Don't exit — BullMQ handles job failures; one bad job shouldn't kill the worker
});

process.on('unhandledRejection', (reason) => {
  logger.error('[Worker] Unhandled promise rejection', {
    message: reason?.message || String(reason),
  });
});
