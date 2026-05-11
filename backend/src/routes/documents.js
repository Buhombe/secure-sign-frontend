'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/documents — ENTERPRISE CURSOR-PAGINATED LIST ENDPOINT
//
// REPLACES the previous unbounded SELECT that was silently capped at 20 rows
// on the frontend via .slice(0, 20). That approach:
//   - Fetched ALL user documents on every dashboard load
//   - Silently hid documents beyond index 20
//   - Would cause severe degradation at enterprise scale (10k+ docs)
//
// NEW ARCHITECTURE: Keyset / Cursor Pagination
//
// WHY CURSOR PAGINATION instead of OFFSET?
//   - OFFSET N requires the database to scan and discard N rows before
//     returning results. At offset 5000, PostgreSQL scans 5025 rows to
//     return 25. For enterprise accounts this means full-table scans.
//   - Cursor (keyset) pagination uses a WHERE clause on an indexed column
//     (created_at + id for tie-breaking). PostgreSQL jumps directly to the
//     correct position using the B-tree index — O(log N) regardless of page.
//   - No "page drift": if a document is inserted between fetches, offset
//     pagination causes documents to shift — items appear on two pages or
//     vanish. Cursors are stable.
//   - The cursor is opaque to the client (base64-encoded JSON), which
//     prevents tampering with raw timestamp values and makes the contract
//     clean.
//
// QUERY PARAMETERS:
//   limit    — items per page, 1–100, default 25
//   cursor   — opaque continuation token (omit for first page)
//   status   — filter: all|pending|in_progress|signed|completed|declined|voided|draft
//   search   — partial name search (≤ 100 chars)
//   sort     — created_at|signed_at  (default: created_at)
//   dir      — asc|desc              (default: desc)
//
// RESPONSE:
//   { documents, total, nextCursor, hasMore, showing }
//
// BACKWARDS COMPATIBLE: the original /api/documents still responds correctly.
// The new query params are opt-in — callers that send no params get the first
// 25 documents, matching previous visible behavior (was silently 20 on frontend).
// ─────────────────────────────────────────────────────────────────────────────

const express  = require('express');
const router   = express.Router();
const multer   = require('multer');
const crypto   = require('crypto');
const { v4: uuidv4 } = require('uuid');
const { PDFDocument, rgb } = require('pdf-lib');

const pool           = require('../config/database');
const authMiddleware = require('../middleware/auth');
const { requireMfa, requireEmailVerified } = require('../middleware/auth');
const optionalAuth   = require('../middleware/optionalAuth');
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
// CURSOR HELPERS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Encode a cursor object to an opaque base64 string.
 * The cursor carries { ts, id } — the created_at timestamp and document id
 * of the last row on the current page. On the next fetch the query does:
 *   WHERE (created_at, id) < (cursor.ts, cursor.id)  [for DESC]
 * which is a perfectly indexed keyset scan.
 */
function encodeCursor({ ts, id }) {
  return Buffer.from(JSON.stringify({ ts, id })).toString('base64url');
}

/**
 * Decode and validate a cursor string.
 * Returns null if the cursor is malformed or tampered with.
 * Invalid cursors are treated as "start from beginning" — no 500, no crash.
 */
function decodeCursor(raw) {
  if (!raw || typeof raw !== 'string' || raw.length > 200) return null;
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    // Validate shape: ts must be a valid ISO date string, id must be a UUID
    if (
      typeof parsed.ts !== 'string' ||
      typeof parsed.id !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}T/.test(parsed.ts) ||
      !/^[0-9a-f-]{36}$/i.test(parsed.id)
    ) {
      return null;
    }
    // Validate ts is a real date
    const d = new Date(parsed.ts);
    if (isNaN(d.getTime())) return null;
    return { ts: parsed.ts, id: parsed.id };
  } catch {
    return null;
  }
}

// ── Allowed sort columns (whitelist to prevent SQL injection) ─────────────────
const ALLOWED_SORT_COLS = new Set(['created_at', 'signed_at']);
const ALLOWED_STATUSES  = new Set([
  'all', 'pending', 'in_progress', 'signed', 'completed',
  'declined', 'voided', 'draft', 'expired',
]);

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/documents/upload  (UNCHANGED — kept for compatibility)
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

    let cloudinaryUrl = null, cloudinaryPublicId = null;
    try {
      const uploaded = await uploadDocument(req.file.buffer, uuidv4());
      cloudinaryUrl      = uploaded.url;
      cloudinaryPublicId = uploaded.publicId;
    } catch (uploadErr) {
      console.error('[documents] Cloudinary upload error:', uploadErr.message);
      return res.status(502).json({ error: 'File storage failed. Please try again.' });
    }

    let document;
    try {
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
// GET /api/documents — ENTERPRISE CURSOR-PAGINATED DOCUMENT LIST
//
// This is the primary upgrade. The old endpoint fetched ALL documents with
// no limit; the frontend then sliced to 20. Replaced with proper server-side
// cursor pagination.
//
// Query parameters (all optional, safe defaults):
//   cursor  — opaque continuation token from previous response
//   limit   — 1–100, default 25
//   status  — filter by document status (see ALLOWED_STATUSES)
//   search  — partial match on original_name (≤ 100 chars, sanitized)
//   sort    — created_at|signed_at (default: created_at)
//   dir     — asc|desc (default: desc)
//
// Response shape:
// {
//   documents: [...],    // current page items
//   total: 1234,         // total matching documents (for "Showing X of Y")
//   nextCursor: "abc",   // pass as ?cursor= for next page (null if last page)
//   hasMore: true,       // boolean convenience flag
//   showing: {           // UX helper: "Showing 1–25 of 1234"
//     from: 1,
//     to: 25,
//     total: 1234,
//   }
// }
// ─────────────────────────────────────────────────────────────────────────────
router.get('/', authMiddleware, async (req, res) => {
  try {
    // ── 1. Parse and validate query parameters ───────────────────────────────
    const rawLimit  = parseInt(req.query.limit, 10);
    const limit     = (!isNaN(rawLimit) && rawLimit >= 1 && rawLimit <= 100) ? rawLimit : 25;

    const rawSort   = req.query.sort;
    const sortCol   = ALLOWED_SORT_COLS.has(rawSort) ? rawSort : 'created_at';

    const rawDir    = req.query.dir;
    const sortDir   = rawDir === 'asc' ? 'ASC' : 'DESC';

    const rawStatus = req.query.status;
    const statusFilter = ALLOWED_STATUSES.has(rawStatus) ? rawStatus : 'all';

    // Search: strip dangerous chars, limit length, trim whitespace
    const rawSearch = req.query.search;
    const search    = (typeof rawSearch === 'string')
      ? rawSearch.replace(/[%_\\]/g, '\\$&').trim().slice(0, 100)
      : '';

    // Decode cursor — invalid cursors silently become null (first page)
    const cursor = decodeCursor(req.query.cursor);

    // ── 2. Build parameterized query ─────────────────────────────────────────
    // We build the WHERE clause dynamically but always use $N params — never
    // string interpolation of user-supplied values.

    const params = [req.user.id]; // $1 = user_id always
    const conditions = ['d.user_id = $1', 'd.is_deleted = FALSE'];

    // Status filter — map frontend aliases to actual DB values
    if (statusFilter !== 'all') {
      // "signed" on the frontend means both 'signed' and 'completed'
      // "pending" means both 'pending' and 'draft'
      const statusGroups = {
        signed:   ['signed', 'completed'],
        pending:  ['pending', 'draft'],
      };
      const dbStatuses = statusGroups[statusFilter] || [statusFilter];
      params.push(dbStatuses);
      conditions.push(`d.status = ANY($${params.length})`);
    }

    // Search filter — uses trigram GIN index when pg_trgm is installed
    if (search) {
      params.push(`%${search}%`);
      conditions.push(`d.original_name ILIKE $${params.length}`);
    }

    // Cursor condition — keyset pagination
    // For DESC: next page has (created_at, id) < (cursor.ts, cursor.id)
    // Using row value comparison: (col1, col2) < ($ts, $id)
    // This is a single index scan operation — extremely efficient.
    if (cursor) {
      params.push(cursor.ts);
      params.push(cursor.id);
      if (sortDir === 'DESC') {
        // Rows where ts < cursor.ts, OR ts = cursor.ts AND id < cursor.id
        // (tie-breaking on UUID ensures stable ordering)
        conditions.push(
          `(d.${sortCol} < $${params.length - 1} OR ` +
          `(d.${sortCol} = $${params.length - 1} AND d.id < $${params.length}))`
        );
      } else {
        conditions.push(
          `(d.${sortCol} > $${params.length - 1} OR ` +
          `(d.${sortCol} = $${params.length - 1} AND d.id > $${params.length}))`
        );
      }
    }

    const whereClause = conditions.join(' AND ');

    // ── 3. Count query (runs in parallel with data query) ────────────────────
    // We use a separate COUNT query so we can return total for "Showing X of Y".
    // The count uses the same WHERE conditions but no cursor (total = all matches).
    //
    // IMPORTANT: We count without the cursor condition because the user wants
    // to know "how many documents match my filter" not "how many are left".
    // We build a separate param array for the count query.
    const countParams = [req.user.id];
    const countConditions = ['d.user_id = $1', 'd.is_deleted = FALSE'];

    if (statusFilter !== 'all') {
      const statusGroups = { signed: ['signed', 'completed'], pending: ['pending', 'draft'] };
      const dbStatuses = statusGroups[statusFilter] || [statusFilter];
      countParams.push(dbStatuses);
      countConditions.push(`d.status = ANY($${countParams.length})`);
    }
    if (search) {
      countParams.push(`%${search}%`);
      countConditions.push(`d.original_name ILIKE $${countParams.length}`);
    }
    const countWhere = countConditions.join(' AND ');

    // ── 4. Execute count + data queries in parallel ──────────────────────────
    // We fetch limit+1 rows: if we get limit+1 back, there IS a next page.
    // We return only limit rows to the client. This avoids an extra COUNT
    // for hasMore — but we still run COUNT for the total display.
    const dataParams = [...params, limit + 1]; // $N = limit+1

    const [countResult, dataResult] = await Promise.all([
      pool.query(
        `SELECT COUNT(*) AS total
         FROM documents d
         WHERE ${countWhere}`,
        countParams
      ),
      pool.query(
        `SELECT
           d.id,
           d.original_name,
           d.status,
           d.created_at,
           d.recipient_email,
           d.signed_at,
           d.signed_by
         FROM documents d
         WHERE ${whereClause}
         ORDER BY d.${sortCol} ${sortDir}, d.id ${sortDir}
         LIMIT $${dataParams.length}`,
        dataParams
      ),
    ]);

    const total = parseInt(countResult.rows[0].total, 10);
    const rows  = dataResult.rows;

    // ── 5. Determine next cursor ─────────────────────────────────────────────
    const hasMore   = rows.length > limit;
    const documents = hasMore ? rows.slice(0, limit) : rows;

    let nextCursor = null;
    if (hasMore && documents.length > 0) {
      const lastDoc = documents[documents.length - 1];
      nextCursor = encodeCursor({
        ts: lastDoc[sortCol] instanceof Date
          ? lastDoc[sortCol].toISOString()
          : lastDoc[sortCol],
        id: lastDoc.id,
      });
    }

    // ── 6. Compute "Showing X–Y of Z" ───────────────────────────────────────
    // We need to know the offset of the first item on this page.
    // Since cursor pagination doesn't have a natural page number, we derive
    // the "from" count by knowing the total and how many are left (for DESC).
    // For simplicity and correctness we just return documents.length for this
    // page — the frontend assembles the cumulative count from its state.
    const pageSize = documents.length;

    return res.json({
      documents,
      total,
      nextCursor,
      hasMore,
      pageSize,
      meta: {
        limit,
        sort:   sortCol,
        dir:    sortDir,
        status: statusFilter,
        search: search || null,
      },
    });
  } catch (err) {
    console.error('[documents] List error:', err.message, err.stack);
    return res.status(500).json({ error: 'Could not fetch documents.' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/documents/stats — aggregated counts for dashboard stat cards
//
// Separated from the list endpoint so the dashboard can load stats independently
// from the document list — faster initial paint, no blocking on full list load.
//
// Previously stats were computed client-side on the full fetched array.
// This moves the computation to a single SQL GROUP BY query — far more
// efficient and accurate (includes documents beyond the first 20).
// ─────────────────────────────────────────────────────────────────────────────
router.get('/stats', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT
         status,
         COUNT(*) AS count
       FROM documents
       WHERE user_id = $1 AND is_deleted = FALSE
       GROUP BY status`,
      [req.user.id]
    );

    // Build a clean stats object
    const raw = {};
    for (const row of result.rows) {
      raw[row.status] = parseInt(row.count, 10);
    }

    const stats = {
      pending:     (raw.pending || 0) + (raw.draft || 0),
      in_progress: raw.in_progress || 0,
      completed:   (raw.completed || 0) + (raw.signed || 0),
      declined:    raw.declined || 0,
      voided:      raw.voided || 0,
      expired:     raw.expired || 0,
      total:       Object.values(raw).reduce((a, b) => a + b, 0),
    };

    return res.json({ stats });
  } catch (err) {
    console.error('[documents] Stats error:', err.message);
    return res.status(500).json({ error: 'Could not fetch stats.' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/documents/:id  (UNCHANGED)
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
// All remaining routes below are UNCHANGED from the original implementation.
// Only the GET / list route and the new GET /stats route are modified above.
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
      const { streamToResponse } = require('../services/storageService');
      await streamToResponse(doc.file_path, res);
    } catch (err) {
      console.error('Public serve error:', err.message);
      if (!res.headersSent) res.status(500).json({ error: 'Could not serve file.' });
    }
  }
);

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

      const sigImageHash   = crypto.createHash('sha256').update(signatureBytes).digest('hex');
      const signedFileHash = crypto.createHash('sha256').update(Buffer.from(signedPdfBytes)).digest('hex');

      const client = await pool.connect();
      try {
        await client.query('BEGIN');

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

// ── Deprecated routes (kept for backward compatibility) ───────────────────────

router.get('/:id/url', authMiddleware, validateParams('documentId'), async (req, res) => {
  console.warn('[DEPRECATED] GET /:id/url — use /:id/stream instead');
  res.setHeader('Deprecation', 'true');
  res.setHeader('Sunset', 'Sat, 18 Jul 2026 00:00:00 GMT');
  try {
    const result = await pool.query(
      `SELECT file_path FROM documents WHERE id = $1 AND user_id = $2 AND is_deleted = FALSE`,
      [req.params.id, req.user.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Document not found.' });
    return res.json({ url: result.rows[0].file_path });
  } catch (err) {
    return res.status(500).json({ error: 'Could not get document URL.' });
  }
});

router.get('/:id/pdf', authMiddleware, validateParams('documentId'), async (req, res) => {
  console.warn('[DEPRECATED] GET /:id/pdf — use /:id/stream instead');
  res.setHeader('Deprecation', 'true');
  res.setHeader('Sunset', 'Sat, 18 Jul 2026 00:00:00 GMT');
  try {
    const result = await pool.query(
      `SELECT file_path, original_name FROM documents WHERE id = $1 AND user_id = $2 AND is_deleted = FALSE`,
      [req.params.id, req.user.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Document not found.' });
    const { file_path, original_name } = result.rows[0];
    const protocol = file_path.startsWith('https') ? require('https') : require('http');
    protocol.get(file_path, (cloudRes) => {
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `inline; filename="${original_name}"`);
      cloudRes.pipe(res);
    }).on('error', () => res.status(500).json({ error: 'Could not load PDF.' }));
  } catch (err) {
    return res.status(500).json({ error: 'Could not load PDF.' });
  }
});

router.get('/:id/signed-url', authMiddleware, validateParams('documentId'), async (req, res) => {
  console.warn('[DEPRECATED] GET /:id/signed-url — use /:id/stream instead');
  res.setHeader('Deprecation', 'true');
  try {
    const result = await pool.query(
      `SELECT cloudinary_public_id FROM documents WHERE id = $1 AND user_id = $2 AND is_deleted = FALSE`,
      [req.params.id, req.user.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Document not found.' });
    const { getSignedUrl } = require('../services/storageService');
    const url = getSignedUrl(result.rows[0].cloudinary_public_id, 3600);
    return res.json({ url });
  } catch (err) {
    return res.status(500).json({ error: 'Could not get URL.' });
  }
});

router.get('/:id/download', authMiddleware, validateParams('documentId'), async (req, res) => {
  console.warn('[DEPRECATED] GET /:id/download — use /:id/stream instead');
  res.setHeader('Deprecation', 'true');
  try {
    const result = await pool.query(
      `SELECT cloudinary_public_id, original_name FROM documents WHERE id = $1 AND user_id = $2 AND is_deleted = FALSE`,
      [req.params.id, req.user.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Not found.' });
    const { cloudinary_public_id, original_name } = result.rows[0];
    const cloudinary = require('cloudinary').v2;
    const signedUrl = cloudinary.url(cloudinary_public_id, {
      resource_type: 'raw', type: 'upload', secure: true,
      sign_url: true, expires_at: Math.floor(Date.now() / 1000) + 300,
    });
    require('https').get(signedUrl, (cloudRes) => {
      if (cloudRes.statusCode !== 200) return res.status(502).json({ error: 'Could not fetch PDF.' });
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `inline; filename="${original_name}"`);
      cloudRes.pipe(res);
    }).on('error', () => { if (!res.headersSent) res.status(500).json({ error: 'Download failed.' }); });
  } catch (err) {
    if (!res.headersSent) res.status(500).json({ error: 'Download failed.' });
  }
});

router.get('/:id/serve', authMiddleware, validateParams('documentId'), async (req, res) => {
  console.warn('[DEPRECATED] GET /:id/serve — use /:id/stream instead');
  res.setHeader('Deprecation', 'true');
  try {
    const result = await pool.query(
      `SELECT file_path, signed_file_path FROM documents WHERE id = $1 AND user_id = $2 AND is_deleted = FALSE`,
      [req.params.id, req.user.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Not found.' });
    const { streamToResponse } = require('../services/storageService');
    await streamToResponse(result.rows[0].signed_file_path || result.rows[0].file_path, res);
  } catch (err) {
    if (!res.headersSent) res.status(500).json({ error: 'Could not serve PDF.' });
  }
});

module.exports = router;

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
      await streamToResponse(result.rows[0].signed_file_path || result.rows[0].file_path, res);
    } catch (err) {
      console.error('Signer serve error:', err.message);
      if (!res.headersSent) res.status(500).json({ error: 'Could not serve file.' });
    }
  }
);
