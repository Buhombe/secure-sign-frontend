'use strict';

const express = require('express');
const router  = express.Router();
const multer  = require('multer');
const crypto  = require('crypto');
const { v4: uuidv4 } = require('uuid');
const { PDFDocument, rgb } = require('pdf-lib');

const pool             = require('../config/database');
const authMiddleware   = require('../middleware/auth');
const { requireMfa, requireEmailVerified } = require('../middleware/auth');
const optionalAuth     = require('../middleware/optionalAuth');
const { fileLimiter, uploadLimiter } = require('../middleware/rateLimiter');
const { validate, validateParams, validateQuery } = require('../middleware/sanitize');
const { upload: uploadCfg } = require('../config/security');

const { hashToken }    = require('../services/encryptionService');
const { generateUserKeyPair, signDocument } = require('../services/cryptoSigningService');
const { log, ACTIONS } = require('../services/auditService');
const { uploadDocument, deleteDocument } = require('../services/storageService');
const { enqueueSigningInvite } = require('../queues/producers');
const { sendSigningEmail, buildSigningUrl } = require('../services/emailService');

// ── Multer — memory storage ───────────────────────────────────────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  fileFilter: (req, file, cb) => {
    file.mimetype === uploadCfg.allowedMimeType
      ? cb(null, true)
      : cb(Object.assign(new Error('Only PDF files are allowed.'), { status: 400 }), false);
  },
  limits: { fileSize: uploadCfg.maxFileSizeBytes },
});

// ── PDF magic-byte check ──────────────────────────────────────────────────────
const PDF_MAGIC = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d]);
function isPdfBuffer(buf) {
  return buf && buf.length >= 5 && buf.slice(0, 5).equals(PDF_MAGIC);
}

// ── Fetch a URL and return its body as a Buffer ───────────────────────────────
function fetchBuffer(url) {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https') ? require('https') : require('http');
    protocol.get(url, (res) => {
      if (res.statusCode !== 200) {
        return reject(new Error(`Failed to fetch document: HTTP ${res.statusCode}`));
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end',  ()  => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    }).on('error', reject);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/documents/upload
// ─────────────────────────────────────────────────────────────────────────────
router.post('/upload', authMiddleware, requireEmailVerified, uploadLimiter, upload.single('pdf'), validate('uploadDocument'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Please select a PDF file.' });
    if (!isPdfBuffer(req.file.buffer)) {
      return res.status(400).json({ error: 'Uploaded file is not a valid PDF.' });
    }

    const fileHash = crypto.createHash('sha256').update(req.file.buffer).digest('hex');

    const { recipient_email } = req.body;
    let recipientTokenRaw    = null;
    let recipientTokenHash   = null;
    const tokenExpiryHours   = parseInt(process.env.RECIPIENT_TOKEN_EXPIRY_HOURS, 10) || 72;
    let recipientTokenExpiry = null;

    if (recipient_email) {
      recipientTokenRaw    = uuidv4();
      recipientTokenHash   = hashToken(recipientTokenRaw);
      recipientTokenExpiry = new Date(Date.now() + tokenExpiryHours * 60 * 60 * 1000);
    }

    // ── Upload to Cloudinary ──────────────────────────────────────────────────
    let cloudinaryUrl = null, cloudinaryPublicId = null;
    try {
      const uploaded = await uploadDocument(req.file.buffer, uuidv4());
      cloudinaryUrl      = uploaded.url;
      cloudinaryPublicId = uploaded.publicId;
    } catch (uploadErr) {
      console.error('[documents] Cloudinary upload error:', uploadErr.message);
      return res.status(502).json({ error: 'File storage failed. Please try again.' });
    }

    // ── Save to database ──────────────────────────────────────────────────────
    // Phase 4 fix: wrap DB insert in try/catch so that if it fails, we clean
    // up the Cloudinary file we just uploaded. Without this, a DB error after
    // a successful upload leaves an orphaned file in Cloudinary with no DB record.
    let document;
    try {
      // FIX P7: use org_id from the authenticated user's DB record, never hardcoded
      const orgRow = await pool.query('SELECT org_id FROM users WHERE id = $1', [req.user.id]);
      const orgId  = orgRow.rows[0]?.org_id || '00000000-0000-0000-0000-000000000001';

      const result = await pool.query(
        `INSERT INTO documents
           (user_id, original_name, file_path, file_hash, status,
            recipient_email, recipient_token, recipient_token_expires_at,
            cloudinary_public_id, org_id)
         VALUES ($1,$2,$3,$4,'pending',$5,$6,$7,$8,$9)
         RETURNING id, original_name, status, created_at`,
        [
          req.user.id,
          req.file.originalname.slice(0, 255),
          cloudinaryUrl,
          fileHash,
          recipient_email || null,
          recipientTokenHash,
          recipientTokenExpiry,
          cloudinaryPublicId,
          orgId,
        ]
      );
      document = result.rows[0];
    } catch (dbErr) {
      // DB insert failed — delete the Cloudinary file to prevent orphan
      console.error('[documents] DB insert failed after upload, cleaning up Cloudinary:', dbErr.message);
      await deleteDocument(cloudinaryPublicId).catch(e =>
        console.error('[documents] Cloudinary cleanup failed:', e.message)
      );
      return res.status(500).json({ error: 'Upload failed. Please try again.' });
    }

    await log({
      userId: req.user.id, documentId: document.id,
      action: ACTIONS.UPLOAD, ipAddress: req.ip,
      deviceInfo: req.headers['user-agent'],
      metadata: { original_name: document.original_name, file_hash: fileHash },
    });

    // ── Send signing email ────────────────────────────────────────────────────
    let emailSent = false;
    if (recipient_email && recipientTokenRaw) {
      const signingLink = buildSigningUrl(document.id, recipientTokenRaw);
      try {
        await enqueueSigningInvite({ documentId: document.id, recipientEmail: recipient_email, documentName: req.file.originalname, signingLink });
        emailSent = true;
      } catch (emailErr) {
        console.error('[documents] Email send failed:', emailErr.message);
      }
    }

    return res.status(201).json({
      message:  'PDF uploaded successfully.',
      document: {
        id:            document.id,
        original_name: document.original_name,
        status:        document.status,
        created_at:    document.created_at,
        email_sent:    emailSent,
        ...(recipientTokenRaw && {
          recipient_token:            recipientTokenRaw,
          recipient_token_expires_at: recipientTokenExpiry,
        }),
      },
    });
  } catch (err) {
    console.error('Upload error:', err.message);
    return res.status(500).json({ error: 'Upload failed.' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/documents — only non-deleted docs
// ─────────────────────────────────────────────────────────────────────────────
router.get('/', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, original_name, status, created_at, recipient_email, signed_at, signed_by
       FROM documents
       WHERE user_id = $1 AND is_deleted = FALSE
       ORDER BY created_at DESC`,
      [req.user.id]
    );
    return res.json({ documents: result.rows });
  } catch (err) {
    console.error('Document list error:', err.message);
    return res.status(500).json({ error: 'Could not fetch documents.' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/documents/:id
// ─────────────────────────────────────────────────────────────────────────────
router.get('/:id', authMiddleware, validateParams('documentId'), async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, original_name, status, created_at, recipient_email, signed_at, signed_by
       FROM documents
       WHERE id = $1 AND user_id = $2 AND is_deleted = FALSE`,
      [req.params.id, req.user.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Document not found.' });

    await log({ userId: req.user.id, documentId: req.params.id, action: ACTIONS.VIEW, ipAddress: req.ip });
    return res.json({ document: result.rows[0] });
  } catch (err) {
    console.error('Document fetch error:', err.message);
    return res.status(500).json({ error: 'Could not fetch document.' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/documents/:id/file — owner download (redirect to Cloudinary URL)
// ─────────────────────────────────────────────────────────────────────────────
router.get('/:id/file', authMiddleware, fileLimiter, validateParams('documentId'), async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT file_path FROM documents
       WHERE id = $1 AND user_id = $2 AND is_deleted = FALSE`,
      [req.params.id, req.user.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Document not found.' });

    await log({ userId: req.user.id, documentId: req.params.id, action: ACTIONS.DOWNLOAD, ipAddress: req.ip });
    return res.redirect(302, result.rows[0].file_path);
  } catch (err) {
    console.error('File serve error:', err.message);
    return res.status(500).json({ error: 'Could not serve file.' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/documents/:id/file/public — recipient token access (one-time)
// ─────────────────────────────────────────────────────────────────────────────
router.get(
  '/:id/file/public',
  optionalAuth, fileLimiter,
  validateParams('documentId'),
  validateQuery('recipientToken'),
  async (req, res) => {
    try {
      const tokenHash = hashToken(req.query.token);
      const result = await pool.query(
        `SELECT file_path, recipient_token_expires_at, recipient_token_used
         FROM documents
         WHERE id = $1 AND recipient_token = $2 AND status != 'revoked' AND is_deleted = FALSE`,
        [req.params.id, tokenHash]
      );
      if (!result.rows[0]) return res.status(404).json({ error: 'Document not found.' });

      const doc = result.rows[0];
      if (doc.recipient_token_expires_at && new Date() > new Date(doc.recipient_token_expires_at)) {
        return res.status(410).json({ error: 'This share link has expired.', code: 'TOKEN_EXPIRED' });
      }
      if (doc.recipient_token_used) {
        return res.status(410).json({ error: 'This share link has already been used.', code: 'TOKEN_USED' });
      }

      await pool.query(`UPDATE documents SET recipient_token_used = TRUE WHERE id = $1`, [req.params.id]);
      await log({
        userId: req.user?.id || null, documentId: req.params.id,
        action: ACTIONS.DOWNLOAD_PUBLIC, ipAddress: req.ip,
        metadata: { one_time_token_consumed: true },
      });

      return res.redirect(302, doc.file_path);
    } catch (err) {
      console.error('Public file serve error:', err.message);
      return res.status(500).json({ error: 'Could not serve file.' });
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/documents/:id/serve/public — recipient token PDF stream (for signing flow)
// Does NOT consume the token — preview only, token consumed on actual sign.
// ─────────────────────────────────────────────────────────────────────────────
router.get(
  '/:id/serve/public',
  optionalAuth, fileLimiter,
  validateParams('documentId'),
  validateQuery('recipientToken'),
  async (req, res) => {
    try {
      const tokenHash = hashToken(req.query.token);
      const result = await pool.query(
        `SELECT file_path, recipient_token_expires_at
         FROM documents
         WHERE id = $1 AND recipient_token = $2
           AND status != 'revoked' AND is_deleted = FALSE`,
        [req.params.id, tokenHash]
      );
      if (!result.rows[0]) {
        return res.status(404).json({ error: 'Document not found.' });
      }
      const doc = result.rows[0];
      if (doc.recipient_token_expires_at && new Date() > new Date(doc.recipient_token_expires_at)) {
        return res.status(410).json({ error: 'This share link has expired.', code: 'TOKEN_EXPIRED' });
      }
      // Token is NOT consumed here — only on the actual sign action.
      const { streamToResponse } = require('../services/storageService');
      await streamToResponse(doc.file_path, res);
    } catch (err) {
      console.error('Public serve error:', err.message);
      if (!res.headersSent) res.status(500).json({ error: 'Could not serve file.' });
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /api/documents/:id — SOFT DELETE
// ─────────────────────────────────────────────────────────────────────────────
router.delete('/:id', authMiddleware, validateParams('documentId'), async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE documents SET is_deleted = TRUE
       WHERE id = $1 AND user_id = $2 AND is_deleted = FALSE
       RETURNING id`,
      [req.params.id, req.user.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Document not found.' });

    await log({ userId: req.user.id, documentId: req.params.id, action: 'SOFT_DELETE', ipAddress: req.ip });
    return res.json({ message: 'Document deleted.' });
  } catch (err) {
    console.error('Delete error:', err.message);
    return res.status(500).json({ error: 'Could not delete document.' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/documents/:id/sign
// ─────────────────────────────────────────────────────────────────────────────
router.post(
  '/:id/sign',
  authMiddleware, requireMfa, requireEmailVerified,
  validateParams('documentId'),
  validate('signDocument'),
  async (req, res) => {
    const { signatureData, sigX, sigY, sigWidth, sigHeight, pageNumber } = req.body;

    try {
      const docResult = await pool.query(
        `SELECT * FROM documents WHERE id = $1 AND user_id = $2 AND is_deleted = FALSE`,
        [req.params.id, req.user.id]
      );
      if (!docResult.rows[0]) return res.status(404).json({ error: 'Document not found.' });
      const document = docResult.rows[0];

      if (document.status === 'signed')   return res.status(400).json({ error: 'Document already signed.' });
      if (document.status === 'revoked')  return res.status(400).json({ error: 'Cannot sign a revoked document.' });

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

      const pdfBytes = await fetchBuffer(document.file_path);
      const { documentHash, signature: cryptoSignature } = signDocument(pdfBytes, private_key_enc);

      const pdfDoc  = await PDFDocument.load(pdfBytes);
      const pages   = pdfDoc.getPages();
      const pageIdx = Math.min(((pageNumber || 1) - 1), pages.length - 1);
      const page    = pages[pageIdx];
      const { width: pageW, height: pageH } = page.getSize();

      const base64Data     = signatureData.replace(/^data:image\/png;base64,/, '');
      const signatureBytes = Buffer.from(base64Data, 'base64');
      const PNG_MAGIC      = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
      if (!signatureBytes.slice(0, 4).equals(PNG_MAGIC)) {
        return res.status(400).json({ error: 'Signature image is not a valid PNG.' });
      }

      const sigImg = await pdfDoc.embedPng(signatureBytes);
      const pdfX   = ((sigX || 0) / 100) * pageW;
      const pdfY   = Math.max(pageH - (((sigY || 0) / 100) * pageH) - (sigHeight || 80), 5);

      page.drawImage(sigImg, { x: pdfX, y: pdfY, width: sigWidth || 200, height: sigHeight || 80 });

      const signedAt    = new Date();
      const signedAtISO = signedAt.toISOString();

      page.drawText(`Signed by: ${userEmail}`,              { x: pdfX, y: Math.max(pdfY - 12, 5), size: 7, color: rgb(0.4, 0.4, 0.4) });
      page.drawText(`Date: ${signedAtISO}`,                  { x: pdfX, y: Math.max(pdfY - 22, 5), size: 7, color: rgb(0.4, 0.4, 0.4) });
      page.drawText(`Hash: ${documentHash.slice(0, 16)}...`, { x: pdfX, y: Math.max(pdfY - 32, 5), size: 6, color: rgb(0.6, 0.6, 0.6) });

      const signedPdfBytes = await pdfDoc.save();

      const [signedUpload, origUpload] = await Promise.all([
        uploadDocument(Buffer.from(signedPdfBytes), `signed-${uuidv4()}`),
        uploadDocument(Buffer.from(pdfBytes),       `orig-${uuidv4()}`),
      ]);

      console.log(`[documents] Signing completed — document: ${req.params.id}, signer: ${userEmail}`);

      const sigImageHash   = crypto.createHash('sha256').update(signatureBytes).digest('hex');
      const signedFileHash = crypto.createHash('sha256').update(Buffer.from(signedPdfBytes)).digest('hex');

      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        // Pessimistic lock — prevent concurrent double-signing
        const lockResult = await client.query(
          `SELECT status FROM documents
           WHERE id = $1 AND user_id = $2 AND is_deleted = FALSE
           FOR UPDATE`,
          [req.params.id, req.user.id]
        );
        if (!lockResult.rows[0]) {
          await client.query('ROLLBACK');
          return res.status(404).json({ error: 'Document not found.' });
        }
        if (lockResult.rows[0].status === 'signed') {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: 'Document already signed.' });
        }
        if (lockResult.rows[0].status === 'revoked') {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: 'Cannot sign a revoked document.' });
        }

        await client.query(
          `INSERT INTO signatures
             (document_id, user_id, signer_email, signature_hash,
              crypto_signature, document_hash,
              sig_x, sig_y, sig_width, sig_height, page_number,
              verified, verification_method, signed_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
          [
            req.params.id, req.user.id, userEmail, sigImageHash,
            cryptoSignature, documentHash,
            sigX || 0, sigY || 0, sigWidth || 200, sigHeight || 80, pageIdx + 1,
            true, 'RSA-PSS-SHA256', signedAt,
          ]
        );

        await client.query(
          `UPDATE documents
           SET status                     = 'signed',
               file_path                  = $1,
               file_hash                  = $2,
               cloudinary_public_id       = $3,
               orig_file_path             = $4,
               orig_cloudinary_public_id  = $5,
               signed_at                  = $6,
               signed_by                  = $7
           WHERE id = $8`,
          [
            signedUpload.url, signedFileHash, signedUpload.publicId,
            origUpload.url, origUpload.publicId,
            signedAt, userEmail,
            req.params.id,
          ]
        );

        const hmacKey = process.env.AUDIT_HMAC_KEY;
        const payload = `${req.user.id}|${req.params.id}|SIGN|${req.ip}|${signedAtISO}`;
        const rowHmac = (hmacKey && hmacKey.length >= 32)
          ? crypto.createHmac('sha256', hmacKey).update(payload).digest('hex')
          : null;

        await client.query(
          `INSERT INTO audit_logs
             (user_id, document_id, action, ip_address, device_info, metadata, timestamp, row_hmac)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [
            req.user.id, req.params.id, 'SIGN', req.ip,
            req.headers['user-agent']?.slice(0, 200),
            JSON.stringify({ document_hash: documentHash, signer_email: userEmail, page_number: pageIdx + 1, method: 'RSA-PSS-SHA256' }),
            signedAtISO, rowHmac,
          ]
        );

        await client.query('COMMIT');
      } catch (txErr) {
        await client.query('ROLLBACK');
        await Promise.all([
          deleteDocument(signedUpload.publicId),
          deleteDocument(origUpload.publicId),
        ]);
        throw txErr;
      } finally {
        client.release();
      }

      return res.json({
        message:       'Document signed successfully.',
        document_hash: documentHash,
        signed_at:     signedAtISO,
        signed_by:     userEmail,
      });
    } catch (err) {
      console.error('Sign error:', err.message);
      return res.status(500).json({ error: 'Signing failed.' });
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/documents/:id/stream — secure proxy stream (primary endpoint)
// ─────────────────────────────────────────────────────────────────────────────
router.get('/:id/stream', authMiddleware, validateParams('documentId'), async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT file_path, signed_file_path, original_name FROM documents
       WHERE id = $1 AND user_id = $2 AND is_deleted = FALSE`,
      [req.params.id, req.user.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Not found.' });

    const { streamToResponse } = require('../services/storageService');
    const pathToServe = result.rows[0].signed_file_path || result.rows[0].file_path;
    await streamToResponse(pathToServe, res);
  } catch (err) {
    console.error('Stream error:', err.message);
    if (!res.headersSent) res.status(500).json({ error: 'Could not stream PDF.' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// DEPRECATED endpoints — use /:id/stream instead
// These are kept for backward compatibility and will be removed in a future release.
// ─────────────────────────────────────────────────────────────────────────────

router.get('/:id/url', authMiddleware, validateParams('documentId'), async (req, res) => {
  console.warn('[DEPRECATED] GET /:id/url — use /:id/stream instead');
  res.setHeader('Deprecation', 'true');
  res.setHeader('Sunset', 'Sat, 18 Jul 2026 00:00:00 GMT');
  res.setHeader('Link', '</api/documents/:id/stream>; rel="successor-version"');
  try {
    const result = await pool.query(
      `SELECT file_path FROM documents
       WHERE id = $1 AND user_id = $2 AND is_deleted = FALSE`,
      [req.params.id, req.user.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Document not found.' });
    return res.json({ url: result.rows[0].file_path });
  } catch (err) {
    console.error('URL fetch error:', err.message);
    return res.status(500).json({ error: 'Could not get document URL.' });
  }
});

router.get('/:id/pdf', authMiddleware, validateParams('documentId'), async (req, res) => {
  console.warn('[DEPRECATED] GET /:id/pdf — use /:id/stream instead');
  res.setHeader('Deprecation', 'true');
  res.setHeader('Sunset', 'Sat, 18 Jul 2026 00:00:00 GMT');
  res.setHeader('Link', '</api/documents/:id/stream>; rel="successor-version"');
  try {
    const result = await pool.query(
      `SELECT file_path, signed_file_path, original_name FROM documents
       WHERE id = $1 AND user_id = $2 AND is_deleted = FALSE`,
      [req.params.id, req.user.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Document not found.' });

    const { file_path, original_name } = result.rows[0];
    const protocol = file_path.startsWith('https') ? require('https') : require('http');
    protocol.get(file_path, (cloudRes) => {
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `inline; filename="${original_name}"`);
      cloudRes.pipe(res);
    }).on('error', (err) => {
      console.error('Proxy error:', err.message);
      res.status(500).json({ error: 'Could not load PDF.' });
    });
  } catch (err) {
    console.error('PDF proxy error:', err.message);
    return res.status(500).json({ error: 'Could not load PDF.' });
  }
});

router.get('/:id/signed-url', authMiddleware, validateParams('documentId'), async (req, res) => {
  console.warn('[DEPRECATED] GET /:id/signed-url — use /:id/stream instead');
  res.setHeader('Deprecation', 'true');
  res.setHeader('Sunset', 'Sat, 18 Jul 2026 00:00:00 GMT');
  res.setHeader('Link', '</api/documents/:id/stream>; rel="successor-version"');
  try {
    const result = await pool.query(
      `SELECT cloudinary_public_id, original_name FROM documents
       WHERE id = $1 AND user_id = $2 AND is_deleted = FALSE`,
      [req.params.id, req.user.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Document not found.' });

    const { cloudinary_public_id } = result.rows[0];
    const { getSignedUrl } = require('../services/storageService');
    const url = getSignedUrl(cloudinary_public_id, 3600);
    return res.json({ url });
  } catch (err) {
    console.error('Signed URL error:', err.message);
    return res.status(500).json({ error: 'Could not get URL.' });
  }
});

router.get('/:id/download', authMiddleware, validateParams('documentId'), async (req, res) => {
  console.warn('[DEPRECATED] GET /:id/download — use /:id/stream instead');
  res.setHeader('Deprecation', 'true');
  res.setHeader('Sunset', 'Sat, 18 Jul 2026 00:00:00 GMT');
  res.setHeader('Link', '</api/documents/:id/stream>; rel="successor-version"');
  try {
    const result = await pool.query(
      `SELECT cloudinary_public_id, original_name FROM documents
       WHERE id = $1 AND user_id = $2 AND is_deleted = FALSE`,
      [req.params.id, req.user.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Not found.' });

    const { cloudinary_public_id, original_name } = result.rows[0];
    const cloudinary = require('cloudinary').v2;
    const signedUrl = cloudinary.url(cloudinary_public_id, {
      resource_type: 'raw',
      type: 'upload',
      secure: true,
      sign_url: true,
      expires_at: Math.floor(Date.now() / 1000) + 300,
    });

    require('https').get(signedUrl, (cloudRes) => {
      if (cloudRes.statusCode !== 200) {
        return res.status(502).json({ error: 'Could not fetch PDF.' });
      }
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `inline; filename="${original_name}"`);
      cloudRes.pipe(res);
    }).on('error', (err) => {
      console.error('Download error:', err.message);
      if (!res.headersSent) res.status(500).json({ error: 'Download failed.' });
    });
  } catch (err) {
    console.error('Download route error:', err.message);
    if (!res.headersSent) res.status(500).json({ error: 'Download failed.' });
  }
});

router.get('/:id/serve', authMiddleware, validateParams('documentId'), async (req, res) => {
  console.warn('[DEPRECATED] GET /:id/serve — use /:id/stream instead');
  res.setHeader('Deprecation', 'true');
  res.setHeader('Sunset', 'Sat, 18 Jul 2026 00:00:00 GMT');
  res.setHeader('Link', '</api/documents/:id/stream>; rel="successor-version"');
  try {
    const result = await pool.query(
      `SELECT file_path, signed_file_path, original_name FROM documents
       WHERE id = $1 AND user_id = $2 AND is_deleted = FALSE`,
      [req.params.id, req.user.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Not found.' });

    const { streamToResponse } = require('../services/storageService');
    const pathToServe = result.rows[0].signed_file_path || result.rows[0].file_path;
    await streamToResponse(pathToServe, res);
  } catch (err) {
    console.error('Serve error:', err.message);
    if (!res.headersSent) res.status(500).json({ error: 'Could not serve PDF.' });
  }
});

module.exports = router;
// GET /api/documents/:id/serve/signer — serve PDF using signer token
router.get(
  '/:id/serve/signer',
  fileLimiter,
  validateParams('documentId'),
  async (req, res) => {
    try {
      const { token } = req.query;
      if (!token || typeof token !== 'string') {
        return res.status(400).json({ error: 'Signing token is required.' });
      }
      const { validateSignerToken } = require('../services/signerService');
      const { valid, error } = await validateSignerToken(req.params.id, token);
      if (!valid) return res.status(401).json({ error });

      const result = await pool.query(
        `SELECT file_path FROM documents WHERE id = $1 AND status != 'revoked' AND is_deleted = FALSE`,
        [req.params.id]
      );
      if (!result.rows[0]) return res.status(404).json({ error: 'Document not found.' });

      const { streamToResponse } = require('../services/storageService');
      const pathToServe = result.rows[0].signed_file_path || result.rows[0].file_path;
    await streamToResponse(pathToServe, res);
    } catch (err) {
      console.error('Signer serve error:', err.message);
      if (!res.headersSent) res.status(500).json({ error: 'Could not serve file.' });
    }
  }
);
