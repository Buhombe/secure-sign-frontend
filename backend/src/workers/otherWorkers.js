'use strict';

/**
 * workers/otherWorkers.js — HakikiSign Workers (v2)
 *
 * CHANGE FROM v1
 * ───────────────
 * + Added 'send-otp' case to the email worker (OTP email fallback)
 *   when WhatsApp OTP delivery is unavailable.
 *
 * ALL OTHER WORKERS AND JOB HANDLERS ARE UNCHANGED.
 * This is a DROP-IN REPLACEMENT.
 */

const { Worker } = require('bullmq');
const logger = require('../config/logger');
const { makeRedisConnection } = require('../queues/index');
const {
  sendSigningEmail,
  sendCompletionEmail,
  sendDeclineEmail,
  sendVerificationEmail,
  sendPasswordResetEmail,
  sendOtpEmail,             // NEW import
} = require('../services/emailService');

// ══════════════════════════════════════════════════════════════════════════════
// QUEUE B — CERTIFICATE WORKER (UNCHANGED)
// ══════════════════════════════════════════════════════════════════════════════

const { generateCertificate } = require('../services/certificateService');

async function handleCertificate(job) {
  const { documentId } = job.data;
  logger.info('[CertWorker] generate-certificate started', { jobId: job.id, documentId });
  await generateCertificate(documentId);
  logger.info('[CertWorker] generate-certificate completed', { jobId: job.id, documentId });
  return { generated: true };
}

function createCertificateWorker() {
  const worker = new Worker('certificate-gen', handleCertificate, {
    ...makeRedisConnection(),
    concurrency: 3,
  });
  worker.on('failed', (job, err) => logger.error('[CertWorker] failed', { jobId: job?.id, message: err.message }));
  worker.on('error',  (err) =>      logger.error('[CertWorker] error',  { message: err.message }));
  return worker;
}

// ══════════════════════════════════════════════════════════════════════════════
// QUEUE C — EMAIL WORKER (CHANGED: added 'send-otp' case)
// ══════════════════════════════════════════════════════════════════════════════

async function handleEmail(job) {
  const { name, data } = job;

  logger.info(`[EmailWorker] ${name} started`, {
    jobId:     job.id,
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

    // NEW: OTP fallback via email (when WhatsApp unavailable)
    // This case is triggered by notificationOrchestrator when WhatsApp OTP
    // fails permanently and the signer only has an email address.
    case 'send-otp': {
      const { recipientEmail, otpCode, documentName, expiryMinutes } = data;
      if (!recipientEmail || !otpCode) {
        logger.warn('[EmailWorker] send-otp: missing required fields', { jobId: job.id });
        break;
      }
      await sendOtpEmail(recipientEmail, otpCode, documentName, expiryMinutes || 10);
      break;
    }

    default:
      throw new Error(`[EmailWorker] Unknown email job: ${name}`);
  }

  logger.info(`[EmailWorker] ${name} completed`, { jobId: job.id });
  return { sent: true };
}

function createEmailWorker() {
  const worker = new Worker('email-delivery', handleEmail, {
    ...makeRedisConnection(),
    concurrency: 10,
  });

  worker.on('completed', (job) => {
    logger.info('[EmailWorker] completed', { jobId: job.id, name: job.name });
  });

  worker.on('failed', (job, err) => {
    logger.error('[EmailWorker] failed', {
      jobId:   job?.id,
      name:    job?.name,
      attempt: job?.attemptsMade,
      message: err.message,
    });
  });

  worker.on('error', (err) => {
    logger.error('[EmailWorker] connection error', { message: err.message });
  });

  return worker;
}

// ══════════════════════════════════════════════════════════════════════════════
// QUEUE D — AUDIT WORKER (UNCHANGED)
// ══════════════════════════════════════════════════════════════════════════════

const { enforceExpiredTokens } = require('../services/tokenService');
const { cleanupCloudinaryAssets } = require('../services/storageService');
const { verifyAuditIntegrity } = require('../services/auditService');
const { enqueueExpiryWarningsSweep } = require('../queues/producers');

async function handleAudit(job) {
  const { name, data } = job;

  logger.info(`[AuditWorker] ${name} started`, { jobId: job.id });

  switch (name) {
    case 'enforce-expirations': {
      const expired = await enforceExpiredTokens();
      logger.info('[AuditWorker] enforce-expirations completed', { expired });

      // After expiry enforcement, queue expiry warnings for tokens nearing expiry
      await enqueueExpiryWarningsSweep({ windowHours: 24 }).catch(err =>
        logger.warn('[AuditWorker] Failed to queue expiry warnings', { message: err.message })
      );

      return { expired };
    }

    case 'cloudinary-cleanup': {
      const { publicIds, reason } = data;
      await cleanupCloudinaryAssets(publicIds, reason);
      return { cleaned: publicIds?.length || 0 };
    }

    case 'audit-integrity-check': {
      const { documentId } = data;
      const result = await verifyAuditIntegrity(documentId);
      return result;
    }

    default:
      throw new Error(`[AuditWorker] Unknown job: ${name}`);
  }
}

function createAuditWorker() {
  const worker = new Worker('audit-security', handleAudit, {
    ...makeRedisConnection(),
    concurrency: 2,
  });

  worker.on('failed', (job, err) => logger.error('[AuditWorker] failed', { jobId: job?.id, name: job?.name, message: err.message }));
  worker.on('error',  (err) =>      logger.error('[AuditWorker] error',  { message: err.message }));
  return worker;
}

// ══════════════════════════════════════════════════════════════════════════════
// QUEUE E — CRYPTO WORKER (UNCHANGED)
// ══════════════════════════════════════════════════════════════════════════════

const { generateRsaKeypair } = require('../services/cryptoSigningService');

async function handleCrypto(job) {
  const { name, data } = job;
  logger.info(`[CryptoWorker] ${name} started`, { jobId: job.id });

  switch (name) {
    case 'generate-rsa-keypair': {
      const { userId } = data;
      await generateRsaKeypair(userId);
      return { generated: true };
    }
    default:
      throw new Error(`[CryptoWorker] Unknown job: ${name}`);
  }
}

function createCryptoWorker() {
  const worker = new Worker('crypto-ops', handleCrypto, {
    ...makeRedisConnection(),
    concurrency: 1, // RSA gen is CPU-intensive
  });

  worker.on('failed', (job, err) => logger.error('[CryptoWorker] failed', { jobId: job?.id, message: err.message }));
  worker.on('error',  (err) =>      logger.error('[CryptoWorker] error',  { message: err.message }));
  return worker;
}

module.exports = {
  createCertificateWorker,
  createEmailWorker,
  createAuditWorker,
  createCryptoWorker,
};
