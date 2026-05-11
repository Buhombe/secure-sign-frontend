'use strict';

const express = require('express');
const router  = express.Router();
const crypto  = require('crypto');

const pool           = require('../config/database');
const authMiddleware = require('../middleware/auth');
const optionalAuth   = require('../middleware/optionalAuth');
const { validateParams, validateQuery } = require('../middleware/sanitize');
const { hashToken }  = require('../services/encryptionService');
const { verifyDocument, publicKeyFingerprint } = require('../services/cryptoSigningService');

// ── Fetch buffer from Cloudinary URL ─────────────────────────────────────────
function fetchBuffer(url) {
  const https = require('https');
  const http  = require('http');
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https') ? https : http;
    protocol.get(url, (res) => {
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode} fetching file`));
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end',  () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    }).on('error', reject);
  });
}

// ── Core verification ─────────────────────────────────────────────────────────
async function performVerification(documentId) {
  const result = await pool.query(
    `SELECT
       d.id, d.original_name, d.file_path, d.orig_file_path, d.status, d.created_at AS uploaded_at,
       s.id              AS signature_id,
       s.signer_email,
       s.crypto_signature,
       s.document_hash   AS stored_doc_hash,
       s.signed_at,
       s.verification_method,
       s.page_number,
       u.public_key
     FROM documents d
     JOIN signatures s ON s.document_id = d.id
     JOIN users     u ON u.id = s.user_id
     WHERE d.id = $1
     ORDER BY s.signed_at DESC LIMIT 1`,
    [documentId]
  );

  if (!result.rows[0]) return { found: false };
  const row = result.rows[0];

  if (!row.crypto_signature || !row.public_key) {
    return {
      found: true, legacy: true,
      message: 'Document signed before cryptographic signatures were enabled.',
      document: {
        id: row.id, original_name: row.original_name,
        status: row.status, signer_email: row.signer_email,
        signed_at: row.signed_at,
      },
    };
  }

  // ── Fetch files from Cloudinary (all storage is remote — no local FS) ─────
  let originalBytes = null;
  let signedBytes   = null;

  try {
    if (!row.file_path || !row.file_path.startsWith('http')) {
      return {
        found: true, valid: false, tampered: true,
        error: 'Signed file URL is not available.',
      };
    }

    signedBytes = await fetchBuffer(row.file_path);

    if (row.orig_file_path && row.orig_file_path.startsWith('http')) {
      try {
        originalBytes = await fetchBuffer(row.orig_file_path);
      } catch (_) {
        // Original backup unavailable — fall back to hash-only verification
      }
    }
  } catch (err) {
    return { found: true, valid: false, error: `Could not fetch file: ${err.message}` };
  }

  let cryptoValid = false;
  let reason      = '';

  if (originalBytes) {
    // Full verification: verify RSA-PSS signature against original PDF bytes
    const verification = verifyDocument(originalBytes, row.crypto_signature, row.public_key);
    cryptoValid = verification.valid;
    reason      = verification.reason;

    // Also check stored hash matches original bytes
    const currentOrigHash = crypto.createHash('sha256').update(originalBytes).digest('hex');
    if (currentOrigHash !== row.stored_doc_hash) {
      cryptoValid = false;
      reason = 'Original file hash mismatch — original PDF may have been tampered.';
    }
  } else {
    // Original PDF not available — cannot perform full RSA-PSS verification.
    // The signature was computed over the original PDF bytes; without them
    // we cannot verify it. We report this honestly rather than running a
    // fallback that would always return invalid (the previous fallback was
    // verifying against the ASCII hex string of the hash, not the PDF bytes).
    //
    // This path should be rare after Phase 3 — both sign routes now upload
    // orig_file_path. It can still occur for documents signed before Phase 3.
    cryptoValid = null;   // null = indeterminate, not false
    reason = 'Original PDF not available for cryptographic verification. ' +
             'The document was signed before full audit trail was enabled, ' +
             'or the original backup could not be retrieved.';
  }

  let keyFingerprint = null;
  try { keyFingerprint = publicKeyFingerprint(row.public_key); } catch (_) {}

  const currentSignedHash = crypto.createHash('sha256').update(signedBytes).digest('hex');

  return {
    found: true, legacy: false,
    valid:    cryptoValid === true,
    tampered: cryptoValid === false,
    indeterminate: cryptoValid === null,
    reason,
    document: {
      id: row.id, original_name: row.original_name,
      status: row.status, uploaded_at: row.uploaded_at,
    },
    signature: {
      id:                       row.signature_id,
      signer_email:             row.signer_email,
      signed_at:                row.signed_at,
      page_number:              row.page_number,
      verification_method:      row.verification_method,
      stored_document_hash:     row.stored_doc_hash,
      current_signed_file_hash: currentSignedHash,
      signer_key_fingerprint:   keyFingerprint,
      full_verification:        !!originalBytes,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/signatures/:documentId/verify
// ─────────────────────────────────────────────────────────────────────────────
router.get('/:documentId/verify', authMiddleware, validateParams('signatureDocumentId'), async (req, res) => {
  try {
    const ownership = await pool.query(
      `SELECT id FROM documents WHERE id = $1 AND user_id = $2 AND is_deleted = FALSE`,
      [req.params.documentId, req.user.id]
    );
    if (!ownership.rows[0]) return res.status(404).json({ error: 'Document not found.' });

    const report = await performVerification(req.params.documentId);
    await pool.query(
      `INSERT INTO audit_logs (user_id, document_id, action, ip_address) VALUES ($1,$2,'VERIFY',$3)`,
      [req.user.id, req.params.documentId, req.ip]
    );
    return res.json(report);
  } catch (err) {
    console.error('Verify error:', err.message);
    return res.status(500).json({ error: 'Verification failed.' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/signatures/:documentId/verify/public
// ─────────────────────────────────────────────────────────────────────────────
router.get(
  '/:documentId/verify/public',
  optionalAuth,
  validateParams('signatureDocumentId'),
  validateQuery('recipientToken'),
  async (req, res) => {
    try {
      const tokenHash = hashToken(req.query.token);
      const ownership = await pool.query(
        `SELECT id FROM documents
         WHERE id = $1 AND recipient_token = $2
           AND status != 'revoked' AND is_deleted = FALSE`,
        [req.params.documentId, tokenHash]
      );
      if (!ownership.rows[0]) return res.status(404).json({ error: 'Document not found.' });
      return res.json(await performVerification(req.params.documentId));
    } catch (err) {
      console.error('Public verify error:', err.message);
      return res.status(500).json({ error: 'Verification failed.' });
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/signatures/:documentId
// ─────────────────────────────────────────────────────────────────────────────
router.get('/:documentId', authMiddleware, validateParams('signatureDocumentId'), async (req, res) => {
  try {
    const ownership = await pool.query(
      `SELECT id FROM documents WHERE id = $1 AND user_id = $2 AND is_deleted = FALSE`,
      [req.params.documentId, req.user.id]
    );
    if (!ownership.rows[0]) return res.status(404).json({ error: 'Document not found.' });

    const result = await pool.query(
      `SELECT id, signer_email, signed_at, page_number, verified,
              verification_method, document_hash, sig_x, sig_y, sig_width, sig_height
       FROM signatures WHERE document_id = $1 ORDER BY signed_at DESC`,
      [req.params.documentId]
    );
    return res.json({ signatures: result.rows });
  } catch (err) {
    console.error('Signatures fetch error:', err.message);
    return res.status(500).json({ error: 'Could not fetch signatures.' });
  }
});

module.exports = router;