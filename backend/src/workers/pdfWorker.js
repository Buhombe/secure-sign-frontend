'use strict';

/**
 * workers/pdfWorker.js — PDF Processing Worker
 *
 * Handles:
 *   stamp-pdf   — embed signature image + text stamp into PDF, upload to Cloudinary
 *   final-hash  — compute SHA-256 of final signed PDF and store in DB
 *
 * IDEMPOTENCY
 * ────────────
 * stamp-pdf: Before stamping, the worker checks whether a signature record
 * already has a `stamped_pdf_path`. If it does, the job is a no-op (returns
 * success). This handles the case where the job is retried after a partial
 * failure (e.g. PDF was stamped and uploaded but the DB write failed).
 *
 * DOCUMENT INTEGRITY
 * ───────────────────
 * The signing transaction (RSA crypto + DB writes) happens synchronously in
 * the route handler BEFORE this worker runs. The worker only handles the
 * cosmetic PDF stamping (visual signature overlay). The cryptographic proof
 * is already recorded in the signatures table. Even if the stamp job fails
 * permanently, the signing is legally valid — the certificate worker will
 * still generate the completion certificate.
 */

const { Worker }          = require('bullmq');
const { PDFDocument, rgb } = require('pdf-lib');
const crypto              = require('crypto');
const { v4: uuidv4 }      = require('uuid');
const pool                = require('../config/database');
const { uploadDocument, deleteDocument } = require('../services/storageService');
const logger              = require('../config/logger');
const { makeRedisConnection } = require('../queues/index');

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

// ── Fetch PDF bytes from a URL ─────────────────────────────────────────────
async function fetchBuffer(url) {
  const https = require('https');
  const http  = require('http');
  const mod   = url.startsWith('https') ? https : http;

  return new Promise((resolve, reject) => {
    mod.get(url, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    }).on('error', reject);
  });
}

// ── Job handlers ───────────────────────────────────────────────────────────

/**
 * handleStampPdf — embeds the visual signature into the PDF.
 *
 * This does NOT redo the cryptographic signing — that already happened in
 * the route handler. This worker only handles the visual stamp and
 * Cloudinary upload of the stamped PDF.
 */
async function handleStampPdf(job) {
  const {
    documentId, signerEmail, signatureData,
    sigX, sigY, sigWidth, sigHeight, pageNumber,
    filePath, correlationId,
  } = job.data;

  logger.info('[PdfWorker] stamp-pdf started', {
    jobId: job.id, documentId, signerEmail, correlationId,
  });

  // ── Idempotency check ──────────────────────────────────────────────────
  // If this document already has a stamped_pdf_path recorded for this signer,
  // a previous run succeeded — skip and return.
  const existing = await pool.query(
    `SELECT stamped_pdf_path FROM signatures
     WHERE document_id = $1 AND signer_email = $2 AND stamped_pdf_path IS NOT NULL
     LIMIT 1`,
    [documentId, signerEmail]
  );
  if (existing.rows[0]?.stamped_pdf_path) {
    logger.info('[PdfWorker] stamp-pdf already done — skipping (idempotent)', {
      jobId: job.id, documentId, signerEmail,
    });
    return { skipped: true, reason: 'already_stamped' };
  }

  // ── Fetch current PDF ──────────────────────────────────────────────────
  const docResult = await pool.query(
    `SELECT file_path FROM documents WHERE id = $1 AND is_deleted = FALSE`,
    [documentId]
  );
  if (!docResult.rows[0]) throw new Error(`Document ${documentId} not found`);

  const pdfBytes = await fetchBuffer(filePath || docResult.rows[0].file_path);

  // ── Embed signature image ──────────────────────────────────────────────
  const base64Data     = signatureData.replace(/^data:image\/png;base64,/, '');
  const signatureBytes = Buffer.from(base64Data, 'base64');

  if (!signatureBytes.slice(0, 4).equals(PNG_MAGIC)) {
    throw new Error('Signature image is not a valid PNG — aborting stamp');
  }

  const pdfDoc  = await PDFDocument.load(pdfBytes);
  const pages   = pdfDoc.getPages();
  const pageIdx = Math.min(((pageNumber || 1) - 1), pages.length - 1);
  const page    = pages[pageIdx];
  const { width: pageW, height: pageH } = page.getSize();

  const sigImg = await pdfDoc.embedPng(signatureBytes);
  const pdfX   = ((sigX || 0) / 100) * pageW;
  const pdfY   = Math.max(pageH - (((sigY || 0) / 100) * pageH) - (sigHeight || 80), 5);

  page.drawImage(sigImg, {
    x: pdfX, y: pdfY,
    width:  sigWidth  || 200,
    height: sigHeight || 80,
  });

  const signedAt = new Date().toISOString();
  page.drawText(`Signed by: ${signerEmail}`, {
    x: pdfX, y: Math.max(pdfY - 12, 5), size: 7, color: rgb(0.4, 0.4, 0.4),
  });
  page.drawText(`Date: ${signedAt}`, {
    x: pdfX, y: Math.max(pdfY - 22, 5), size: 7, color: rgb(0.4, 0.4, 0.4),
  });

  const stampedPdfBytes = await pdfDoc.save();
  const stampedHash     = crypto.createHash('sha256').update(stampedPdfBytes).digest('hex');

  // ── Upload stamped PDF ─────────────────────────────────────────────────
  const upload = await uploadDocument(
    Buffer.from(stampedPdfBytes),
    `stamped-${uuidv4()}`
  );

  // ── Store stamped PDF path on signature row ────────────────────────────
  // Update both the signatures record and the documents record.
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(
      `UPDATE signatures
       SET stamped_pdf_path = $1,
           stamped_pdf_hash = $2
       WHERE document_id = $3 AND signer_email = $4`,
      [upload.url, stampedHash, documentId, signerEmail]
    );

    // Update documents.file_path to the latest stamped version
    await client.query(
      `UPDATE documents
       SET file_path            = $1,
           cloudinary_public_id = $2,
           final_hash           = $3
       WHERE id = $4`,
      [upload.url, upload.publicId, stampedHash, documentId]
    );

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    // Clean up the upload to prevent orphans
    await deleteDocument(upload.publicId).catch(e =>
      logger.error('[PdfWorker] Cloudinary cleanup failed after DB rollback', { message: e.message })
    );
    throw err;
  } finally {
    client.release();
  }

  logger.info('[PdfWorker] stamp-pdf completed', {
    jobId: job.id, documentId, signerEmail,
    stampedUrl: upload.url.slice(0, 60),
  });

  return { documentId, signerEmail, stampedUrl: upload.url, stampedHash };
}

/**
 * handleFinalHash — computes and records the final SHA-256 hash of the
 * fully-stamped PDF (after all signers have signed).
 */
async function handleFinalHash(job) {
  const { documentId } = job.data;

  logger.info('[PdfWorker] final-hash started', { jobId: job.id, documentId });

  const docResult = await pool.query(
    `SELECT file_path FROM documents WHERE id = $1 AND is_deleted = FALSE`,
    [documentId]
  );
  if (!docResult.rows[0]) throw new Error(`Document ${documentId} not found`);

  const pdfBytes  = await fetchBuffer(docResult.rows[0].file_path);
  const finalHash = crypto.createHash('sha256').update(pdfBytes).digest('hex');

  await pool.query(
    `UPDATE documents SET final_hash = $1 WHERE id = $2`,
    [finalHash, documentId]
  );

  logger.info('[PdfWorker] final-hash completed', { jobId: job.id, documentId, finalHash });
  return { documentId, finalHash };
}

// ── Worker registration ─────────────────────────────────────────────────────

function createPdfWorker() {
  const worker = new Worker(
    'pdf-processing',
    async (job) => {
      switch (job.name) {
        case 'stamp-pdf':   return handleStampPdf(job);
        case 'final-hash':  return handleFinalHash(job);
        default:
          throw new Error(`Unknown job name: ${job.name}`);
      }
    },
    {
      ...makeRedisConnection(),
      concurrency: 3,  // 3 PDFs in parallel — CPU-bound but async I/O dominates
      limiter: {
        max:      10,
        duration: 60_000,  // max 10 PDF jobs per minute (Cloudinary rate limit safety)
      },
    }
  );

  worker.on('completed', (job, result) => {
    logger.info(`[PdfWorker] Job completed`, {
      jobId: job.id, name: job.name, result,
    });
  });

  worker.on('failed', (job, err) => {
    logger.error(`[PdfWorker] Job failed`, {
      jobId:    job?.id,
      name:     job?.name,
      attempt:  job?.attemptsMade,
      maxAttempts: job?.opts?.attempts,
      message:  err.message,
    });
  });

  worker.on('error', (err) => {
    logger.error('[PdfWorker] Worker error', { message: err.message });
  });

  return worker;
}

module.exports = { createPdfWorker };
