'use strict';

/**
 * audit.js — audit log query endpoints
 *
 * GET /api/audit                  — user's own logs (paginated)
 * GET /api/audit/document/:id     — full history of a specific document
 * GET /api/audit/verify           — HMAC integrity check of all log rows
 *                                   (admin-only in production — gated by env flag)
 */

const express        = require('express');
const router         = express.Router();
const authMiddleware = require('../middleware/auth');
const { validateParams } = require('../middleware/sanitize');
const { getUserLogs, getDocumentLogs, verifyIntegrity } = require('../services/auditService');
const pool           = require('../config/database');

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/audit — current user's own audit trail
// ─────────────────────────────────────────────────────────────────────────────
router.get('/', authMiddleware, async (req, res) => {
  try {
    const limit  = Math.min(parseInt(req.query.limit,  10) || 50,  200);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0,   0);
    const action = req.query.action || null;

    const logs = await getUserLogs({
      userId: req.user.id,
      action,
      limit,
      offset,
    });

    return res.json({ logs, limit, offset });
  } catch (err) {
    console.error('Audit fetch error:', err.message);
    return res.status(500).json({ error: 'Could not fetch audit logs.' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/audit/document/:id — full history of a document
// Only the document owner can see its full audit trail.
// ─────────────────────────────────────────────────────────────────────────────
router.get('/document/:id', authMiddleware, validateParams('documentId'), async (req, res) => {
  try {
    // Ownership check
    const ownership = await pool.query(
      `SELECT id FROM documents WHERE id = $1 AND user_id = $2`,
      [req.params.id, req.user.id]
    );
    if (!ownership.rows[0]) {
      return res.status(404).json({ error: 'Document not found.' });
    }

    const logs = await getDocumentLogs({ documentId: req.params.id });
    return res.json({ logs });
  } catch (err) {
    console.error('Document audit fetch error:', err.message);
    return res.status(500).json({ error: 'Could not fetch document audit logs.' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/audit/verify — HMAC integrity check
// In production, gated by AUDIT_VERIFY_ENABLED=true env flag.
// Allows detection of tampered log rows.
// ─────────────────────────────────────────────────────────────────────────────
router.get('/verify', authMiddleware, async (req, res) => {
  // Gate: only available if explicitly enabled
  if (process.env.NODE_ENV === 'production' && process.env.AUDIT_VERIFY_ENABLED !== 'true') {
    return res.status(403).json({ error: 'Audit verification not enabled in this environment.' });
  }

  try {
    const limit  = Math.min(parseInt(req.query.limit, 10)  || 1000, 5000);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

    const report = await verifyIntegrity({ limit, offset });
    return res.json(report);
  } catch (err) {
    console.error('Audit verify error:', err.message);
    return res.status(500).json({ error: 'Integrity verification failed.' });
  }
});

module.exports = router;