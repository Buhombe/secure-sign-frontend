'use strict';

/**
 * worker.js — HakikiSign Background Job Worker Process
 *
 * This file is the entry point for the SEPARATE Railway worker service.
 * It is NOT imported by index.js (the API server).
 *
 * RAILWAY DEPLOYMENT
 * ───────────────────
 * In Railway, create a second service in the same project:
 *   - Source: same GitHub repo as the backend
 *   - Start command: node src/worker.js
 *   - Share the same environment variables as the API service
 *   - Scale independently from the API server
 *
 * WHY A SEPARATE PROCESS?
 * ────────────────────────
 * Workers run long-running CPU and I/O tasks. If workers ran inside the API
 * process, a slow PDF job would starve the event loop and delay HTTP responses
 * for all users. A separate process has its own event loop, its own memory
 * heap, and its own CPU time slice — complete isolation.
 *
 * SCHEDULED JOBS
 * ───────────────
 * This worker also registers recurring jobs using BullMQ's repeat feature:
 *   - Expiration enforcement: every 15 minutes
 *   - These jobs are added to the queue with a repeat config; BullMQ uses
 *     Redis to ensure only one instance of each recurring job runs at a time
 *     even when multiple worker instances are deployed.
 *
 * GRACEFUL SHUTDOWN
 * ──────────────────
 * On SIGTERM (Railway deploy/scale event):
 *   1. Stop accepting new jobs (worker.pause())
 *   2. Wait for in-progress jobs to finish (worker.close())
 *   3. Close queue connections
 *   4. Exit cleanly
 *
 * BullMQ marks jobs as active when a worker picks them up. If the worker
 * crashes without completing a job, BullMQ's lock mechanism times out (default
 * 30s) and the job is re-queued automatically — no jobs are lost.
 */

require('dotenv').config();

const logger  = require('./config/logger');
const {
  auditQueue,
  emailQueue,
  closeQueues,
} = require('./queues/index');
const { createPdfWorker }  = require('./workers/pdfWorker');
const {
  createCertificateWorker,
  createEmailWorker,
  createAuditWorker,
  createCryptoWorker,
} = require('./workers/otherWorkers');

// ── Validate environment ──────────────────────────────────────────────────────
if (!process.env.REDIS_URL) {
  logger.warn('[Worker] REDIS_URL not set — workers will use localhost Redis');
}

if (!process.env.FIELD_ENCRYPTION_KEY) {
  logger.error('[Worker] FIELD_ENCRYPTION_KEY not set — crypto worker will fail');
  process.exit(1);
}

// ── Start all workers ─────────────────────────────────────────────────────────
logger.info('[Worker] Starting HakikiSign background workers');

const workers = [
  createPdfWorker(),
  createCertificateWorker(),
  createEmailWorker(),
  createAuditWorker(),
  createCryptoWorker(),
];

logger.info('[Worker] All workers started', {
  count: workers.length,
  queues: [
    'pdf-processing',
    'certificate-gen',
    'email-delivery',
    'audit-security',
    'crypto-ops',
  ],
});

// ── Recurring / scheduled jobs ────────────────────────────────────────────────
// Register recurring jobs. BullMQ uses a distributed lock in Redis so only
// one worker instance runs each recurring job, even when scaled to N replicas.

async function registerRecurringJobs() {
  try {
    // Expiration enforcement every 15 minutes
    await auditQueue.add(
      'enforce-expirations',
      { triggeredAt: new Date().toISOString() },
      {
        jobId: 'recurring:expire',
        repeat: { every: 15 * 60 * 1000 }, // every 15 minutes
        attempts: 3,
      }
    );

    logger.info('[Worker] Recurring jobs registered');
  } catch (err) {
    // Non-fatal — recurring jobs will be registered on next startup
    logger.error('[Worker] Failed to register recurring jobs', { message: err.message });
  }
}

registerRecurringJobs();

// ── Graceful shutdown ─────────────────────────────────────────────────────────
async function gracefulShutdown(signal) {
  logger.info(`[Worker] Received ${signal} — beginning graceful shutdown`);

  // Pause all workers — stop picking up new jobs
  await Promise.allSettled(workers.map(w => w.pause()));
  logger.info('[Worker] All workers paused');

  // Close all workers — wait for in-progress jobs to complete (up to their timeout)
  await Promise.allSettled(workers.map(w => w.close()));
  logger.info('[Worker] All workers closed');

  // Close queue connections
  await closeQueues();
  logger.info('[Worker] Graceful shutdown complete');

  process.exit(0);
}

// Force exit after 60 seconds (generous — allows long PDF jobs to finish)
const SHUTDOWN_TIMEOUT_MS = 60_000;

process.once('SIGTERM', async () => {
  setTimeout(() => {
    logger.error('[Worker] Graceful shutdown timed out — forcing exit');
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
  await gracefulShutdown('SIGTERM');
});

process.once('SIGINT', async () => {
  setTimeout(() => {
    logger.error('[Worker] Graceful shutdown timed out — forcing exit');
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
  await gracefulShutdown('SIGINT');
});

// Catch unhandled errors — log and exit so Railway restarts the process
process.on('uncaughtException', (err) => {
  logger.error('[Worker] Uncaught exception', {
    message: err.message,
    stack:   err.stack?.slice(0, 500),
  });
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  logger.error('[Worker] Unhandled rejection', {
    reason: String(reason),
  });
  process.exit(1);
});
