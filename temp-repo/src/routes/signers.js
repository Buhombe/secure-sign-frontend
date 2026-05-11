'use strict';

/**
 * signers.js — multi-signer signing routes.
 *
 * Phase 1 security hardening:
 *   - /sign-public now identifies signers by a raw one-time token in the
 *     request body; signerEmail is NEVER read from the client.
 *   - /sign (authenticated) derives identity from the JWT, not from body.
 *   - /regenerate-link (new) lets an owner mint a fresh link for a pending
 *     signer; any prior link for that signer is invalidated server-side.
 */

const express = require('express');
const router  = express.Router();
const { v4: uuidv4 } = require('uuid');
const { PDFDocument, rgb } = require('pdf-lib');
const crypto = require('crypto');
const https  = require('https');
const http   = require('http');

const pool           = require('../config/database');
const authMiddleware = require('../middleware/auth');
const { requireMfa, requireEmailVerified } = require('../middleware/auth');
const { validateParams } = require('../middleware/sanitize');

const { generateUserKeyPair, signDocument } = require('../services/cryptoSigningService');
const { authLimiter } = require('../middleware/rateLimiter');
const { uploadDocument, deleteDocument } = require('../services/storageService');
const { buildSigningUrl } = require('../services/emailService');
const {
  addSigners,
  sendSigningEmailForOrder,
  validateSignerToken,
  validateAuthenticatedSigner,
  markSignedAndNotifyNext,
  getDocumentSigners,
  issueSignerToken,
} = require('../services/signerService');

// ── Helper: fetch PDF buffer from a URL (Cloudinary) ──────────────────────────
function fetchBuffer(url) {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https') ? https : http;
    protocol.get(url, (res) => {
      if (res.statusCode !== 200) {
        return reject(new Error(`Failed to fetch PDF: HTTP ${res.statusCode}`));
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end',  ()  => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    }).on('error', reject);
  });
}

// ── PNG magic-byte guard — same check used elsewhere for uploaded sig images ──
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/signers/:documentId — list signers on a document (owner only)
// ─────────────────────────────────────────────────────────────────────────────
router.get(
  '/:documentId',
  authMiddleware,
  validateParams('signatureDocumentId'),
  async (req, res) => {
    try {
      const ownership = await pool.query(
        `SELECT id FROM documents WHERE id = $1 AND user_id = $2 AND is_deleted = FALSE`,
        [req.params.documentId, req.user.id]
      );
      if (!ownership.rows[0]) return res.status(404).json({ error: 'Document not found.' });

      const signers = await getDocumentSigners(req.params.documentId);
      return res.json({ signers });
    } catch (err) {
      console.error('Get signers error:', err.message);
      return res.status(500).json({ error: 'Could not fetch signers.' });
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/signers/:documentId/add — owner adds signer list
// ─────────────────────────────────────────────────────────────────────────────
router.post(
  '/:documentId/add',
  authMiddleware,
  validateParams('signatureDocumentId'),
  async (req, res) => {
    try {
      const { signers } = req.body;
      if (!Array.isArray(signers) || signers.length === 0) {
        return res.status(400).json({ error: 'Please provide at least one signer email.' });
      }
      if (signers.length > 10) {
        return res.status(400).json({ error: 'Maximum 10 signers allowed.' });
      }

      const ownership = await pool.query(
        `SELECT id, original_name FROM documents
         WHERE id = $1 AND user_id = $2 AND is_deleted = FALSE AND status = 'pending'`,
        [req.params.documentId, req.user.id]
      );
      if (!ownership.rows[0]) {
        return res.status(404).json({ error: 'Document not found or already signed.' });
      }

      await addSigners(req.params.documentId, signers);

      // Issue a token + email the first signer. Subsequent signers are
      // notified just-in-time after the prior signer completes.
      await sendSigningEmailForOrder(
        req.params.documentId, 1, ownership.rows[0].original_name
      );

      return res.json({
        message: `${signers.length} signer(s) added. Email sent to first signer.`,
      });
    } catch (err) {
      console.error('Add signers error:', err.message);
      return res.status(500).json({ error: 'Could not add signers.' });
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/signers/:documentId/regenerate-link
//   Owner-only. Returns a fresh signing link for a pending signer and
//   rotates the DB-stored token hash, invalidating any prior link.
// ─────────────────────────────────────────────────────────────────────────────
router.post(
  '/:documentId/regenerate-link',
  authMiddleware,
  validateParams('signatureDocumentId'),
  async (req, res) => {
    try {
      const { email } = req.body || {};
      if (!email || typeof email !== 'string') {
        return res.status(400).json({ error: 'Signer email is required.' });
      }

      const ownership = await pool.query(
        `SELECT id FROM documents
         WHERE id = $1 AND user_id = $2 AND is_deleted = FALSE`,
        [req.params.documentId, req.user.id]
      );
      if (!ownership.rows[0]) {
        return res.status(404).json({ error: 'Document not found.' });
      }

      const signerRow = await pool.query(
        `SELECT order_num, status FROM document_signers
         WHERE document_id = $1 AND email = $2`,
        [req.params.documentId, email.toLowerCase()]
      );
      if (!signerRow.rows[0]) {
        return res.status(404).json({ error: 'Signer not found on this document.' });
      }
      if (signerRow.rows[0].status === 'signed') {
        return res.status(400).json({ error: 'This signer has already signed.' });
      }

      const { rawToken } = await issueSignerToken(
        req.params.documentId, signerRow.rows[0].order_num
      );
      const link = buildSigningUrl(req.params.documentId, rawToken);

      // Raw token is returned ONCE. Owner is responsible for sharing it.
      // Any previously issued link for this signer is now invalid.
      return res.json({ link });
    } catch (err) {
      console.error('Regenerate link error:', err.message);
      return res.status(500).json({ error: 'Could not regenerate link.' });
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/signers/:documentId/sign — authenticated signer (JWT)
//   Identity comes from req.user.email (JWT). The request body MUST NOT
//   carry a signerEmail; any such field is ignored.
// ─────────────────────────────────────────────────────────────────────────────
router.post(
  '/:documentId/sign',
  authMiddleware,
  requireMfa, requireEmailVerified,
  validateParams('signatureDocumentId'),
  async (req, res) => {
    const { signatureData, sigX, sigY, sigWidth, sigHeight, pageNumber } = req.body;

    try {
      // Identity = JWT. Any body-level signerEmail is ignored.
      const { valid, error } = await validateAuthenticatedSigner(
        req.params.documentId, req.user.email
      );
      if (!valid) return res.status(403).json({ error });

      const docResult = await pool.query(
        `SELECT * FROM documents WHERE id = $1 AND is_deleted = FALSE`,
        [req.params.documentId]
      );
      if (!docResult.rows[0]) return res.status(404).json({ error: 'Document not found.' });
      const document = docResult.rows[0];

      const userResult = await pool.query(
        `SELECT email, public_key, private_key_enc FROM users WHERE id = $1`,
        [req.user.id]
      );
      let { email: userEmail, public_key, private_key_enc } = userResult.rows[0];

      if (!public_key || !private_key_enc) {
        const keyPair   = await generateUserKeyPair();
        public_key      = keyPair.publicKeyPem;
        private_key_enc = keyPair.encryptedPrivateKey;
        await pool.query(
          `UPDATE users SET public_key = $1, private_key_enc = $2 WHERE id = $3`,
          [public_key, private_key_enc, req.user.id]
        );
      }

      // Fetch PDF from Cloudinary
      const pdfBytes = await fetchBuffer(document.file_path);

      const { documentHash, signature: cryptoSignature } =
        signDocument(pdfBytes, private_key_enc);

      const pdfDoc  = await PDFDocument.load(pdfBytes);
      const pages   = pdfDoc.getPages();
      const pageIdx = Math.min(((pageNumber || 1) - 1), pages.length - 1);
      const page    = pages[pageIdx];
      const { width: pageW, height: pageH } = page.getSize();

      const base64Data     = signatureData.replace(/^data:image\/png;base64,/, '');
      const signatureBytes = Buffer.from(base64Data, 'base64');
      if (!signatureBytes.slice(0, 4).equals(PNG_MAGIC)) {
        return res.status(400).json({ error: 'Signature image is not a valid PNG.' });
      }

      const sigImg = await pdfDoc.embedPng(signatureBytes);
      const pdfX   = ((sigX || 0) / 100) * pageW;
      const pdfY   = Math.max(pageH - (((sigY || 0) / 100) * pageH) - (sigHeight || 80), 5);

      page.drawImage(sigImg, {
        x: pdfX, y: pdfY,
        width: sigWidth || 200, height: sigHeight || 80,
      });

      const signedAt    = new Date();
      const signedAtISO = signedAt.toISOString();

      page.drawText(`Signed by: ${userEmail}`,
        { x: pdfX, y: Math.max(pdfY - 12, 5), size: 7, color: rgb(0.4, 0.4, 0.4) });
      page.drawText(`Date: ${signedAtISO}`,
        { x: pdfX, y: Math.max(pdfY - 22, 5), size: 7, color: rgb(0.4, 0.4, 0.4) });

      const signedPdfBytes = await pdfDoc.save();

      // Phase 3 fix: upload BOTH the signed PDF and a copy of the original bytes.
      // The original is needed so signatures.js can verify the RSA-PSS signature
      // (which was computed over pdfBytes, not signedPdfBytes). Without orig_file_path
      // full cryptographic verification is impossible.
      const [signedUpload, origUpload] = await Promise.all([
        uploadDocument(Buffer.from(signedPdfBytes), `signed-${uuidv4()}`),
        uploadDocument(Buffer.from(pdfBytes),       `orig-${uuidv4()}`),
      ]);

      const sigImageHash = crypto.createHash('sha256').update(signatureBytes).digest('hex');

      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        await client.query(
          `INSERT INTO signatures
             (document_id, user_id, signer_email, signature_hash,
              crypto_signature, document_hash,
              sig_x, sig_y, sig_width, sig_height, page_number,
              verified, verification_method, signed_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
          [
            req.params.documentId, req.user.id, userEmail, sigImageHash,
            cryptoSignature, documentHash,
            sigX || 0, sigY || 0, sigWidth || 200, sigHeight || 80, pageIdx + 1,
            true, 'RSA-PSS-SHA256', signedAt,
          ]
        );

        await client.query(
          `UPDATE documents
           SET file_path                 = $1,
               cloudinary_public_id      = $2,
               orig_file_path            = $3,
               orig_cloudinary_public_id = $4
           WHERE id = $5`,
          [signedUpload.url, signedUpload.publicId,
           origUpload.url,   origUpload.publicId,
           req.params.documentId]
        );

        await client.query('COMMIT');
      } catch (txErr) {
        await client.query('ROLLBACK');
        // Clean up both Cloudinary uploads on DB failure
        await Promise.all([
          deleteDocument(signedUpload.publicId),
          deleteDocument(origUpload.publicId),
        ]).catch(e => console.error('[signers/sign] Cloudinary cleanup failed:', e.message));
        throw txErr;
      } finally {
        client.release();
      }

      const result = await markSignedAndNotifyNext(
        req.params.documentId, userEmail, document.original_name
      );

      console.log(`[signers] ${userEmail} signed document ${req.params.documentId}`);

      return res.json({
        message: result.complete
          ? 'Document fully signed by all signers!'
          : `Signed successfully. Waiting for signer ${result.nextOrder}.`,
        complete:  result.complete,
        signed_at: signedAtISO,
      });
    } catch (err) {
      console.error('Multi-sign error:', err.message);
      return res.status(500).json({ error: 'Signing failed.' });
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/signers/:documentId/sign-public — signer WITHOUT account
//   Identity: raw one-time token in body → DB lookup → authoritative email.
//   `signerEmail` in body is IGNORED (never trusted).
// ─────────────────────────────────────────────────────────────────────────────
router.post(
  '/:documentId/sign-public',
  authLimiter,
  validateParams('signatureDocumentId'),
  async (req, res) => {
    const { token, signatureData, sigX, sigY, sigWidth, sigHeight, pageNumber } = req.body;

    try {
      const { valid, error, signer } = await validateSignerToken(
        req.params.documentId, token
      );
      if (!valid) return res.status(401).json({ error });

      // Authoritative identity — sourced from DB, not from client.
      const authoritativeEmail = signer.email;

      const docResult = await pool.query(
        `SELECT * FROM documents WHERE id = $1 AND is_deleted = FALSE`,
        [req.params.documentId]
      );
      if (!docResult.rows[0]) return res.status(404).json({ error: 'Document not found.' });
      const document = docResult.rows[0];

      // Fetch PDF from Cloudinary
      const pdfBytes = await fetchBuffer(document.file_path);

      const pdfDoc  = await PDFDocument.load(pdfBytes);
      const pages   = pdfDoc.getPages();
      const pageIdx = Math.min(((pageNumber || 1) - 1), pages.length - 1);
      const page    = pages[pageIdx];
      const { width: pageW, height: pageH } = page.getSize();

      const base64Data     = signatureData.replace(/^data:image\/png;base64,/, '');
      const signatureBytes = Buffer.from(base64Data, 'base64');
      if (!signatureBytes.slice(0, 4).equals(PNG_MAGIC)) {
        return res.status(400).json({ error: 'Signature image is not a valid PNG.' });
      }

      const sigImg = await pdfDoc.embedPng(signatureBytes);
      const pdfX   = ((sigX || 0) / 100) * pageW;
      const pdfY   = Math.max(pageH - (((sigY || 0) / 100) * pageH) - (sigHeight || 80), 5);

      page.drawImage(sigImg, {
        x: pdfX, y: pdfY,
        width: sigWidth || 200, height: sigHeight || 80,
      });

      const signedAt = new Date();
      page.drawText(`Signed by: ${authoritativeEmail}`,
        { x: pdfX, y: Math.max(pdfY - 12, 5), size: 7, color: rgb(0.4, 0.4, 0.4) });
      page.drawText(`Date: ${signedAt.toISOString()}`,
        { x: pdfX, y: Math.max(pdfY - 22, 5), size: 7, color: rgb(0.4, 0.4, 0.4) });

      const signedPdfBytes = await pdfDoc.save();

      // Phase 3 fix: upload both signed PDF and original bytes for full crypto verification.
      const [signedUpload, origUpload] = await Promise.all([
        uploadDocument(Buffer.from(signedPdfBytes), `signed-${uuidv4()}`),
        uploadDocument(Buffer.from(pdfBytes),       `orig-${uuidv4()}`),
      ]);

      const sigImageHash = crypto.createHash('sha256').update(signatureBytes).digest('hex');
      const tokenHash    = require('../services/encryptionService').hashToken(token);

      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        // Phase 3 / Phase 5 fix: re-validate the token INSIDE the transaction with
        // FOR UPDATE to prevent double-signing via concurrent requests.
        // Two requests arriving simultaneously will both pass the pre-check above,
        // but only one will win the row lock here — the second will see token_used = TRUE
        // and be rejected before any DB writes occur.
        const lockResult = await client.query(
          `SELECT id, status, token_used, token_expires_at, order_num
           FROM document_signers
           WHERE document_id = $1 AND token = $2
           FOR UPDATE`,
          [req.params.documentId, tokenHash]
        );

        if (!lockResult.rows[0]) {
          await client.query('ROLLBACK');
          await Promise.all([
            deleteDocument(signedUpload.publicId),
            deleteDocument(origUpload.publicId),
          ]).catch(() => {});
          return res.status(401).json({ error: 'Invalid or unknown signing link.' });
        }

        const lockedSigner = lockResult.rows[0];

        if (lockedSigner.token_used || lockedSigner.status === 'signed') {
          await client.query('ROLLBACK');
          await Promise.all([
            deleteDocument(signedUpload.publicId),
            deleteDocument(origUpload.publicId),
          ]).catch(() => {});
          return res.status(409).json({ error: 'This document has already been signed.' });
        }

        // Mark token as used immediately inside the transaction — blocks any concurrent request
        await client.query(
          `UPDATE document_signers
           SET token_used = TRUE, token = NULL, token_expires_at = NULL
           WHERE document_id = $1 AND id = $2`,
          [req.params.documentId, lockedSigner.id]
        );

        await client.query(
          `INSERT INTO signatures
             (document_id, signer_email, signature_hash, sig_x, sig_y,
              sig_width, sig_height, page_number, verified, verification_method, signed_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [
            req.params.documentId, authoritativeEmail, sigImageHash,
            sigX || 0, sigY || 0, sigWidth || 200, sigHeight || 80, pageIdx + 1,
            true, 'EMAIL-TOKEN', signedAt,
          ]
        );

        await client.query(
          `UPDATE documents
           SET file_path                 = $1,
               cloudinary_public_id      = $2,
               orig_file_path            = $3,
               orig_cloudinary_public_id = $4
           WHERE id = $5`,
          [signedUpload.url, signedUpload.publicId,
           origUpload.url,   origUpload.publicId,
           req.params.documentId]
        );

        await client.query('COMMIT');
      } catch (txErr) {
        await client.query('ROLLBACK');
        // Clean up Cloudinary uploads on any DB failure
        await Promise.all([
          deleteDocument(signedUpload.publicId),
          deleteDocument(origUpload.publicId),
        ]).catch(e => console.error('[signers/sign-public] Cloudinary cleanup failed:', e.message));
        throw txErr;
      } finally {
        client.release();
      }

      const result = await markSignedAndNotifyNext(
        req.params.documentId, authoritativeEmail, document.original_name
      );

      console.log(`[signers] Public sign: ${authoritativeEmail} signed document ${req.params.documentId}`);

      return res.json({
        message: result.complete
          ? 'Document fully signed by all signers!'
          : 'Signed successfully. Next signer has been notified.',
        complete:  result.complete,
        signed_at: signedAt.toISOString(),
      });
    } catch (err) {
      console.error('Public sign error:', err.message);
      return res.status(500).json({ error: 'Signing failed.' });
    }
  }
);

module.exports = router;
