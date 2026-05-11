'use strict';

/**
 * workers/otherWorkers.js — Certificate, Email, Audit, and Crypto Workers
 *
 * Four workers in one file for deployment simplicity.
 * Each is independently instantiated with its own concurrency setting.
 */

const { Worker }   = require('bullmq');
const pool         = require('../config/database');
const logger       = require('../config/logger');
const { makeRedisConnection } = require('../queues/index');
const { generateAndStoreCertificate } = require('../services/certificateService');
const {
  sendSigningEmail,
  sendVerificationEmail,
  sendPasswordResetEmail,
  sendCompletionEmail,
  sendDeclineEmail,
  buildSigningUrl,
} = require('../services/emailService');
const { deleteDocument } = require('../services/storageService');
const { generateUserKeyPair } = require('../services/cryptoSigningService');

// ══════════════════════════════════════════════════════════════════════════════
// QUEUE B — CERTIFICATE WORKER
// ══════════════════════════════════════════════════════════════════════════════

async function handleGenerateCertificate(job) {
  const { documentId } = job.data;

  logger.info('[CertWorker] generate-certificate started', {
    jobId: job.id, documentId,
  });

  // Idempotency: if certificate already exists, skip.
  const existing = await pool.query(
    `SELECT certificate_path FROM documents WHERE id = $1`,
    [documentId]
  );
  if (existing.rows[0]?.certificate_path) {
    logger.info('[CertWorker] Certificate already exists — skipping', {
      jobId: job.id, documentId,
    });
    return { skipped: true, reason: 'already_generated' };
  }

  const result = await generateAndStoreCertificate(documentId);

  logger.info('[CertWorker] generate-certificate completed', {
    jobId: job.id, documentId, url: result.url?.slice(0, 60),
  });

  return { documentId, url: result.url };
}

function createCertificateWorker() {
  const worker = new Worker(
    'certificate-gen',
    async (job) => {
      if (job.name === 'generate-certificate') return handleGenerateCertificate(job);
      throw new Error(`Unknown job: ${job.name}`);
    },
    {
      ...makeRedisConnection(),
      concurrency: 2,  // certificate generation is I/O + CPU; keep low
    }
  );

  worker.on('completed', (job, result) => {
    logger.info('[CertWorker] Job completed', { jobId: job.id, result });
  });

  worker.on('failed', (job, err) => {
    logger.error('[CertWorker] Job failed', {
      jobId:   job?.id,
      attempt: job?.attemptsMade,
      message: err.message,
    });
  });

  worker.on('error', (err) => {
    logger.error('[CertWorker] Worker error', { message: err.message });
  });

  return worker;
}

// ══════════════════════════════════════════════════════════════════════════════
// QUEUE C — EMAIL WORKER
// ══════════════════════════════════════════════════════════════════════════════

async function handleEmail(job) {
  const { name, data } = job;

  logger.info(`[EmailWorker] ${name} started`, {
    jobId: job.id,
    recipient: data.recipientEmail || data.ownerEmail || data.signerEmail,
  });

  switch (name) {
    case 'send-signing-invite': {
      const { recipientEmail, documentName, signingLink } = data;
      await sendSigningEmail(recipientEmail, signingLink, documentName);
      break;
    }

    case 'send-completion': {
      const { ownerEmail, documentName, signerEmails } = data;
      await sendCompletionEmail(ownerEmail, documentName, signerEmails || []);
      break;
    }

    case 'send-reminder': {
      const { signerEmail, documentName, signingLink } = data;
      // sendSigningEmail doubles as reminder — same template, different context.
      await sendSigningEmail(signerEmail, signingLink, documentName);
      break;
    }

    case 'send-decline-notification': {
      const { ownerEmail, documentName, signerEmail, reason } = data;
      if (!ownerEmail) {
        logger.warn('[EmailWorker] send-decline-notification: missing ownerEmail', { jobId: job.id });
        break;
      }
      await sendDeclineEmail(ownerEmail, documentName, signerEmail, reason);
      break;
    }

    case 'send-verification': {
      const { recipientEmail, verifyLink } = data;
      await sendVerificationEmail(recipientEmail, verifyLink);
      break;
    }

    case 'send-password-reset': {
      const { recipientEmail, resetLink } = data;
      await sendPasswordResetEmail(recipientEmail, resetLink);
      break;
    }

    default:
      throw new Error(`Unknown email job: ${name}`);
  }

  logger.info(`[EmailWorker] ${name} completed`, { jobId: job.id });
  return { sent: true };
}

function createEmailWorker() {
  const worker = new Worker(
    'email-delivery',
    handleEmail,
    {
      ...makeRedisConnection(),
      // Email is pure I/O — high concurrency is safe and improves throughput
      // during bulk sends (e.g. 50-signer envelope).
      concurrency: 10,
    }
  );

  worker.on('completed', (job) => {
    logger.info('[EmailWorker] Job completed', { jobId: job.id, name: job.name });
  });

  worker.on('failed', (job, err) => {
    const isFinal = job?.attemptsMade >= (job?.opts?.attempts || 7);
    logger.error('[EmailWorker] Job failed', {
      jobId:   job?.id,
      name:    job?.name,
      attempt: job?.attemptsMade,
      final:   isFinal,
      message: err.message,
    });
    if (isFinal) {
      // Dead-letter event — route handler or admin dashboard can alert on this.
      logger.security('EMAIL_DELIVERY_DEAD_LETTER', {
        jobId:     job?.id,
        jobName:   job?.name,
        recipient: job?.data?.recipientEmail || job?.data?.ownerEmail,
        documentId: job?.data?.documentId,
      });
    }
  });

  worker.on('error', (err) => {
    logger.error('[EmailWorker] Worker error', { message: err.message });
  });

  return worker;
}

// ══════════════════════════════════════════════════════════════════════════════
// QUEUE D — AUDIT & SECURITY WORKER
// ══════════════════════════════════════════════════════════════════════════════

async function handleAuditJob(job) {
  const { name, data } = job;
  logger.info(`[AuditWorker] ${name} started`, { jobId: job.id });

  switch (name) {
    case 'enforce-expirations': {
      // Mark expired signer tokens as expired
      const tokenResult = await pool.query(
        `UPDATE document_signers
         SET status = 'expired'
         WHERE status = 'pending'
           AND token_expires_at IS NOT NULL
           AND token_expires_at < NOW()
         RETURNING id`
      );

      // Mark documents past their signing deadline
      const docResult = await pool.query(
        `UPDATE documents
         SET status = 'expired'
         WHERE status = 'pending'
           AND expires_at IS NOT NULL
           AND expires_at < NOW()
           AND signing_complete = FALSE
         RETURNING id`
      );

      logger.info('[AuditWorker] enforce-expirations completed', {
        jobId:            job.id,
        expiredTokens:    tokenResult.rowCount,
        expiredDocuments: docResult.rowCount,
      });

      return {
        expiredTokens:    tokenResult.rowCount,
        expiredDocuments: docResult.rowCount,
      };
    }

    case 'cloudinary-cleanup': {
      const { publicIds, reason } = data;
      const results = await Promise.allSettled(
        (publicIds || []).map(id => deleteDocument(id))
      );

      const failed = results.filter(r => r.status === 'rejected');
      if (failed.length > 0) {
        logger.error('[AuditWorker] Some Cloudinary deletions failed', {
          jobId:  job.id,
          failed: failed.map(f => f.reason?.message),
          reason,
        });
        if (failed.length === publicIds.length) {
          // All failed — throw so BullMQ retries the job
          throw new Error(`All ${publicIds.length} Cloudinary deletions failed`);
        }
      }

      logger.info('[AuditWorker] cloudinary-cleanup completed', {
        jobId:     job.id,
        total:     publicIds.length,
        succeeded: results.length - failed.length,
        failed:    failed.length,
        reason,
      });

      return { deleted: results.length - failed.length, failed: failed.length };
    }

    case 'audit-integrity-check': {
      const { documentId } = data;
      const hmacKey = process.env.AUDIT_HMAC_KEY;
      if (!hmacKey || hmacKey.length < 32) {
        logger.warn('[AuditWorker] AUDIT_HMAC_KEY not configured — skipping integrity check');
        return { skipped: true };
      }

      const crypto = require('crypto');
      const rows = await pool.query(
        `SELECT user_id, document_id, action, ip_address, timestamp, row_hmac
         FROM audit_logs
         WHERE document_id = $1 AND row_hmac IS NOT NULL
         ORDER BY timestamp ASC`,
        [documentId]
      );

      let failures = 0;
      for (const row of rows.rows) {
        const payload  = `${row.user_id}|${row.document_id}|${row.action}|${row.ip_address}|${new Date(row.timestamp).toISOString()}`;
        const expected = crypto.createHmac('sha256', hmacKey).update(payload).digest('hex');
        if (expected !== row.row_hmac) {
          failures++;
          logger.security('AUDIT_INTEGRITY_FAILURE', {
            documentId,
            action:    row.action,
            timestamp: row.timestamp,
          });
        }
      }

      logger.info('[AuditWorker] audit-integrity-check completed', {
        jobId: job.id, documentId,
        checked:  rows.rows.length,
        failures,
      });

      return { checked: rows.rows.length, failures };
    }

    default:
      throw new Error(`Unknown audit job: ${name}`);
  }
}

function createAuditWorker() {
  const worker = new Worker(
    'audit-security',
    handleAuditJob,
    {
      ...makeRedisConnection(),
      concurrency: 2, // audit jobs can be slow — keep concurrency low
    }
  );

  worker.on('completed', (job, result) => {
    logger.info('[AuditWorker] Job completed', { jobId: job.id, name: job.name, result });
  });

  worker.on('failed', (job, err) => {
    logger.error('[AuditWorker] Job failed', {
      jobId:   job?.id,
      name:    job?.name,
      attempt: job?.attemptsMade,
      message: err.message,
    });
  });

  worker.on('error', (err) => {
    logger.error('[AuditWorker] Worker error', { message: err.message });
  });

  return worker;
}

// ══════════════════════════════════════════════════════════════════════════════
// QUEUE E — CRYPTO WORKER
// ══════════════════════════════════════════════════════════════════════════════

async function handleCryptoJob(job) {
  const { name, data } = job;
  logger.info(`[CryptoWorker] ${name} started`, { jobId: job.id });

  switch (name) {
    case 'generate-rsa-keypair': {
      const { userId } = data;

      // Idempotency: check if keys already exist
      const existing = await pool.query(
        `SELECT public_key FROM users WHERE id = $1 AND public_key IS NOT NULL`,
        [userId]
      );
      if (existing.rows[0]) {
        logger.info('[CryptoWorker] Keys already exist — skipping', { jobId: job.id, userId });
        return { skipped: true, reason: 'keys_already_exist' };
      }

      // RSA-2048 key generation — CPU-intensive, isolated in worker process
      const keyPair = await generateUserKeyPair();

      await pool.query(
        `UPDATE users
         SET public_key      = $1,
             private_key_enc = $2
         WHERE id = $3 AND public_key IS NULL`,
        [keyPair.publicKeyPem, keyPair.encryptedPrivateKey, userId]
      );

      logger.info('[CryptoWorker] RSA key pair generated and stored', {
        jobId: job.id, userId,
      });

      return { userId, generated: true };
    }

    default:
      throw new Error(`Unknown crypto job: ${name}`);
  }
}

function createCryptoWorker() {
  const worker = new Worker(
    'crypto-ops',
    handleCryptoJob,
    {
      ...makeRedisConnection(),
      // concurrency=1 for crypto worker — RSA generation is CPU-bound.
      // Running multiple simultaneously on the same core provides no benefit
      // and causes CPU contention. Scale by adding more Railway instances
      // with concurrency=1 each.
      concurrency: 1,
    }
  );

  worker.on('completed', (job, result) => {
    logger.info('[CryptoWorker] Job completed', { jobId: job.id, name: job.name, result });
  });

  worker.on('failed', (job, err) => {
    logger.error('[CryptoWorker] Job failed', {
      jobId:   job?.id,
      name:    job?.name,
      attempt: job?.attemptsMade,
      message: err.message,
    });
  });

  worker.on('error', (err) => {
    logger.error('[CryptoWorker] Worker error', { message: err.message });
  });

  return worker;
}

module.exports = {
  createCertificateWorker,
  createEmailWorker,
  createAuditWorker,
  createCryptoWorker,
};
