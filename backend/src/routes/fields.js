'use strict';

/**
 * fields.js — Phase 8 endpoints.
 *
 *  Owner-facing:
 *    POST   /api/fields/:documentId             Save the full field set
 *    GET    /api/fields/:documentId             List all fields on a doc
 *    GET    /api/fields/:documentId/certificate Download Certificate of Completion
 *    POST   /api/fields/:documentId/regenerate-certificate  Force regen
 *
 *  Signer-facing (token-gated, no JWT required):
 *    GET    /api/fields/:documentId/my?token=…  Fields for current signer only
 *    POST   /api/fields/:documentId/view-event  Log a VIEWED event
 */

const express = require('express');
const router  = express.Router();
const https   = require('https');
const http    = require('http');

const pool             = require('../config/database');
const authMiddleware   = require('../middleware/auth');
const { validateParams, validate } = require('../middleware/sanitize');
const { authLimiter, fileLimiter } = require('../middleware/rateLimiter');
const {
  replaceFields,
  getFieldsForDocument,
  getFieldsForSigner,
} = require('../services/fieldService');
const {
  validateSignerToken,
  recordSignerEvent,
} = require('../services/signerService');
const { generateAndStoreCertificate } = require('../services/certificateService');

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/fields/:documentId — owner saves the full field set
// ─────────────────────────────────────────────────────────────────────────────
router.post(
  '/:documentId',
  authMiddleware,
  validateParams('signatureDocumentId'),
  validate('placeFields'),
  async (req, res) => {
    try {
      const ownership = await pool.query(
        `SELECT id FROM documents
         WHERE id = $1 AND user_id = $2 AND is_deleted = FALSE`,
        [req.params.documentId, req.user.id]
      );
      if (!ownership.rows[0]) {
        return res.status(404).json({ error: 'Document not found.' });
      }

      await replaceFields(req.params.documentId, req.body.fields);
      return res.json({ message: 'Fields saved.', count: req.body.fields.length });
    } catch (err) {
      console.error('Place fields error:', err.message);
      return res.status(500).json({ error: 'Could not save fields.' });
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/fields/:documentId — owner lists fields
// ─────────────────────────────────────────────────────────────────────────────
router.get(
  '/:documentId',
  authMiddleware,
  validateParams('signatureDocumentId'),
  async (req, res) => {
    try {
      const ownership = await pool.query(
        `SELECT id FROM documents
         WHERE id = $1 AND user_id = $2 AND is_deleted = FALSE`,
        [req.params.documentId, req.user.id]
      );
      if (!ownership.rows[0]) {
        return res.status(404).json({ error: 'Document not found.' });
      }

      const fields = await getFieldsForDocument(req.params.documentId);
      return res.json({ fields });
    } catch (err) {
      console.error('List fields error:', err.message);
      return res.status(500).json({ error: 'Could not fetch fields.' });
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/fields/:documentId/my — signer fetches ONLY their fields
// ─────────────────────────────────────────────────────────────────────────────
router.get(
  '/:documentId/my',
  authLimiter,
  validateParams('signatureDocumentId'),
  async (req, res) => {
    try {
      const token = req.query.token;
      if (!token || typeof token !== 'string') {
        return res.status(400).json({ error: 'Signing token is required.' });
      }
      const { valid, error, signer } =
        await validateSignerToken(req.params.documentId, token);
      if (!valid) return res.status(401).json({ error });

      const fields = await getFieldsForSigner(req.params.documentId, signer.id);
      return res.json({
        fields,
        signer: { id: signer.id, email: signer.email, order_num: signer.order_num },
      });
    } catch (err) {
      console.error('Signer field fetch error:', err.message);
      return res.status(500).json({ error: 'Could not fetch fields.' });
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/fields/:documentId/view-event — log VIEWED for a signer
// ─────────────────────────────────────────────────────────────────────────────
router.post(
  '/:documentId/view-event',
  authLimiter,
  validateParams('signatureDocumentId'),
  async (req, res) => {
    try {
      const token = req.body?.token;
      if (!token || typeof token !== 'string') {
        return res.status(400).json({ error: 'Token required.' });
      }
      const { valid, signer } =
        await validateSignerToken(req.params.documentId, token);
      if (!valid) return res.status(200).json({ ok: false });

      await recordSignerEvent({
        documentId:  req.params.documentId,
        signerId:    signer.id,
        signerEmail: signer.email,
        eventType:   'viewed',
        ipAddress:   req.ip,
        userAgent:   req.headers['user-agent'] || null,
      });
      return res.json({ ok: true });
    } catch (err) {
      console.error('View event error:', err.message);
      return res.status(200).json({ ok: false });
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/fields/:documentId/certificate — download Certificate of Completion
//   Streams the PDF stored in Cloudinary. 404 if envelope is not yet complete.
// ─────────────────────────────────────────────────────────────────────────────
router.get(
  '/:documentId/certificate',
  authMiddleware, fileLimiter,
  validateParams('signatureDocumentId'),
  async (req, res) => {
    try {
      const result = await pool.query(
        `SELECT certificate_path, signing_complete, original_name
         FROM documents
         WHERE id = $1 AND user_id = $2 AND is_deleted = FALSE`,
        [req.params.documentId, req.user.id]
      );
      if (!result.rows[0]) return res.status(404).json({ error: 'Document not found.' });

      const { certificate_path, signing_complete, original_name } = result.rows[0];

      if (!signing_complete) {
        return res.status(409).json({ error: 'Envelope is not yet complete.' });
      }
      if (!certificate_path) {
        return res.status(404).json({
          error: 'Certificate is still being generated. Try again in a few seconds.',
        });
      }

      const protocol = certificate_path.startsWith('https') ? https : http;
      protocol.get(certificate_path, (cloudRes) => {
        if (cloudRes.statusCode !== 200) {
          return res.status(502).json({ error: 'Certificate fetch failed.' });
        }
        const safeName = (original_name || 'document').replace(/[^a-zA-Z0-9._-]/g, '_');
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition',
          `attachment; filename="certificate-${safeName}.pdf"`);
        cloudRes.pipe(res);
      }).on('error', (err) => {
        console.error('Certificate stream error:', err.message);
        if (!res.headersSent) res.status(500).json({ error: 'Could not download certificate.' });
      });
    } catch (err) {
      console.error('Certificate error:', err.message);
      if (!res.headersSent) res.status(500).json({ error: 'Could not download certificate.' });
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/fields/:documentId/regenerate-certificate — owner re-renders cert
// ─────────────────────────────────────────────────────────────────────────────
router.post(
  '/:documentId/regenerate-certificate',
  authMiddleware,
  validateParams('signatureDocumentId'),
  async (req, res) => {
    try {
      const result = await pool.query(
        `SELECT signing_complete FROM documents
         WHERE id = $1 AND user_id = $2 AND is_deleted = FALSE`,
        [req.params.documentId, req.user.id]
      );
      if (!result.rows[0]) return res.status(404).json({ error: 'Document not found.' });
      if (!result.rows[0].signing_complete) {
        return res.status(409).json({ error: 'Envelope is not yet complete.' });
      }

      const up = await generateAndStoreCertificate(req.params.documentId);
      return res.json({ message: 'Certificate regenerated.', url: up.url });
    } catch (err) {
      console.error('Regen certificate error:', err.message);
      return res.status(500).json({ error: 'Could not regenerate certificate.' });
    }
  }
);

module.exports = router;
