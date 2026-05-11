'use strict';

/**
 * queues/index.js — HakikiSign BullMQ Queue Registry
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * ARCHITECTURE OVERVIEW
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * Five queues, each handling a distinct workload category:
 *
 *   pdf-processing     — PDF stamping, signature embedding, hash computation
 *   certificate-gen    — Certificate-of-completion PDF generation
 *   email-delivery     — All transactional emails (invite, remind, complete)
 *   audit-security     — Scheduled cleanup, expiration enforcement, integrity checks
 *   crypto-ops         — RSA-2048 key generation (CPU-intensive, isolated)
 *
 * WHY SEPARATE QUEUES?
 * ─────────────────────
 * 1. INDEPENDENT SCALING — each queue gets its own worker concurrency setting.
 *    RSA key gen (CPU-bound) runs concurrency=1; email delivery (I/O-bound)
 *    runs concurrency=10.
 *
 * 2. INDEPENDENT RETRY POLICIES — email uses aggressive backoff (provider
 *    outages); PDF uses fewer retries (data corruption is non-recoverable).
 *
 * 3. OBSERVABILITY — queue-level metrics are meaningful only when queues are
 *    separated. Mixing PDF and email jobs in one queue makes latency metrics
 *    meaningless.
 *
 * 4. FAILURE ISOLATION — a PDF worker crash does not affect email delivery.
 *
 * SHARED CONNECTION POOL
 * ───────────────────────
 * BullMQ requires separate ioredis connections for Queue (producer) and
 * Worker (consumer). This is because Workers use the Redis BLPOP blocking
 * command which cannot multiplex with other commands on the same connection.
 *
 * We create a connection factory so each Queue and Worker gets its own
 * dedicated ioredis instance, all sharing the same configuration.
 *
 * RAILWAY DEPLOYMENT
 * ───────────────────
 * The API server (index.js) runs as one Railway service — it enqueues jobs.
 * Workers run as a SEPARATE Railway service (worker.js) — they process jobs.
 * Both services connect to the same Redis instance via REDIS_URL.
 * This separation means:
 *   - Worker CPU spikes don't affect API response times
 *   - Workers can be scaled independently
 *   - Railway can restart workers without touching the API server
 */

const { Queue } = require('bullmq');
const logger    = require('../config/logger');

// ── Redis connection factory ──────────────────────────────────────────────────
// Each call returns a NEW ioredis config object (not a shared client).
// BullMQ creates its own ioredis instances from this config.
function makeRedisConnection() {
  const url = process.env.REDIS_URL;
  if (!url) {
    logger.warn('[Queues] REDIS_URL not set — BullMQ will not function');
  }

  return {
    // BullMQ accepts either a connection URL string or ioredis options object.
    // Using the URL directly is Railway-compatible.
    ...(url
      ? { connection: { url } }
      : { connection: { host: 'localhost', port: 6379 } }
    ),
  };
}

// ── Default job options ───────────────────────────────────────────────────────
// These are the BASE defaults. Individual enqueue calls override as needed.
const BASE_JOB_OPTS = {
  removeOnComplete: { count: 500 },  // keep last 500 completed jobs for debugging
  removeOnFail:     { count: 1000 }, // keep last 1000 failed jobs for forensics
};

// ── Queue: PDF Processing (Queue A) ──────────────────────────────────────────
const pdfQueue = new Queue('pdf-processing', {
  ...makeRedisConnection(),
  defaultJobOptions: {
    ...BASE_JOB_OPTS,
    attempts:    3,
    backoff: { type: 'exponential', delay: 5_000 },  // 5s, 10s, 20s
    timeout:     120_000,  // 2 minutes — large PDFs can take time
  },
});

// ── Queue: Certificate Generation (Queue B) ───────────────────────────────────
const certificateQueue = new Queue('certificate-gen', {
  ...makeRedisConnection(),
  defaultJobOptions: {
    ...BASE_JOB_OPTS,
    attempts:    5,
    backoff: { type: 'exponential', delay: 3_000 },  // 3s, 6s, 12s, 24s, 48s
    timeout:     60_000,   // 1 minute
  },
});

// ── Queue: Email Delivery (Queue C) ──────────────────────────────────────────
const emailQueue = new Queue('email-delivery', {
  ...makeRedisConnection(),
  defaultJobOptions: {
    ...BASE_JOB_OPTS,
    attempts:    7,
    backoff: { type: 'exponential', delay: 10_000 }, // 10s → ~10 min at max
    timeout:     30_000,   // 30 seconds per email attempt
  },
});

// ── Queue: Audit & Security (Queue D) ────────────────────────────────────────
const auditQueue = new Queue('audit-security', {
  ...makeRedisConnection(),
  defaultJobOptions: {
    ...BASE_JOB_OPTS,
    attempts:    3,
    backoff: { type: 'exponential', delay: 30_000 }, // 30s, 60s, 120s
    timeout:     300_000,  // 5 minutes — bulk expiration jobs can be slow
  },
});

// ── Queue: Crypto Operations (Queue E) ───────────────────────────────────────
const cryptoQueue = new Queue('crypto-ops', {
  ...makeRedisConnection(),
  defaultJobOptions: {
    ...BASE_JOB_OPTS,
    attempts:    2,
    backoff: { type: 'fixed', delay: 2_000 },
    timeout:     30_000,   // RSA-2048 takes ~200ms; 30s is very generous
    priority:    10,       // high priority — user is waiting for this
  },
});

// ── Queue health logging ──────────────────────────────────────────────────────
// Log queue errors — BullMQ emits 'error' on connection failures.
[
  { name: 'pdf-processing',  q: pdfQueue },
  { name: 'certificate-gen', q: certificateQueue },
  { name: 'email-delivery',  q: emailQueue },
  { name: 'audit-security',  q: auditQueue },
  { name: 'crypto-ops',      q: cryptoQueue },
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
  ]);
  logger.info('[Queues] All queues closed');
}

module.exports = {
  pdfQueue,
  certificateQueue,
  emailQueue,
  auditQueue,
  cryptoQueue,
  makeRedisConnection,
  closeQueues,
};
