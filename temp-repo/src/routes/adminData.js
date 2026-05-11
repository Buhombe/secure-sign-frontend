'use strict';

const express = require('express');
const router  = express.Router();
const pool    = require('../config/database');
const { adminAuth, requirePermission, logAdminAction } = require('../middleware/adminAuth');

router.use(adminAuth);

// ── GET /api/admin/documents ──────────────────────────────────────────────────
router.get('/documents', requirePermission('documents.read'), async (req, res) => {
  try {
    const { search, status, page = 1, limit = 20 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);
    const params = [];
    let where = 'WHERE d.is_deleted = FALSE';

    if (search) {
      params.push(`%${search.toLowerCase()}%`);
      where += ` AND (LOWER(d.original_name) LIKE $${params.length} OR LOWER(u.email) LIKE $${params.length})`;
    }
    if (status) {
      params.push(status);
      where += ` AND d.status = $${params.length}`;
    }

    params.push(parseInt(limit), offset);

    const result = await pool.query(
      `SELECT
         d.id, d.original_name, d.status, d.created_at, d.signed_at,
         d.recipient_email, d.file_path,
         u.email AS owner_email
       FROM documents d
       JOIN users u ON u.id = d.user_id
       ${where}
       ORDER BY d.created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    const countResult = await pool.query(
      `SELECT COUNT(*) FROM documents d JOIN users u ON u.id = d.user_id ${where}`,
      params.slice(0, -2)
    );

    return res.json({
      documents: result.rows,
      total: parseInt(countResult.rows[0].count),
      page: parseInt(page),
      limit: parseInt(limit),
    });
  } catch (err) {
    console.error('Admin documents error:', err.message);
    return res.status(500).json({ error: 'Could not fetch documents.' });
  }
});

// ── GET /api/admin/documents/:id ──────────────────────────────────────────────
router.get('/documents/:id', requirePermission('documents.read'), async (req, res) => {
  try {
    const doc = await pool.query(
      `SELECT d.*, u.email AS owner_email
       FROM documents d JOIN users u ON u.id = d.user_id
       WHERE d.id = $1`,
      [req.params.id]
    );
    if (!doc.rows[0]) return res.status(404).json({ error: 'Document not found.' });

    const sigs = await pool.query(
      `SELECT signer_email, signed_at, verification_method FROM signatures WHERE document_id = $1`,
      [req.params.id]
    );

    return res.json({ document: doc.rows[0], signatures: sigs.rows });
  } catch (err) {
    return res.status(500).json({ error: 'Could not fetch document.' });
  }
});

// ── DELETE /api/admin/documents/:id — SOFT DELETE ONLY ───────────────────────
router.delete('/documents/:id', requirePermission('documents.delete'), async (req, res) => {
  try {
    // Signed documents require super_admin
    const doc = await pool.query('SELECT status FROM documents WHERE id = $1', [req.params.id]);
    if (!doc.rows[0]) return res.status(404).json({ error: 'Document not found.' });

    if (doc.rows[0].status === 'signed' && req.admin.role !== 'super_admin') {
      return res.status(403).json({ error: 'Only super_admin can delete signed documents.' });
    }

    await pool.query(
      `UPDATE documents SET is_deleted = TRUE WHERE id = $1`,
      [req.params.id]
    );

    await logAdminAction(req.admin.id, 'DOCUMENT_DELETED', 'document', req.params.id, null, req);
    return res.json({ message: 'Document soft-deleted.' });
  } catch (err) {
    return res.status(500).json({ error: 'Could not delete document.' });
  }
});

// ── GET /api/admin/stats ──────────────────────────────────────────────────────
router.get('/stats', requirePermission('stats.read'), async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        (SELECT COUNT(*) FROM users WHERE is_deleted = FALSE)                    AS total_users,
        (SELECT COUNT(*) FROM users WHERE is_deleted = FALSE AND is_suspended = FALSE AND created_at > NOW() - INTERVAL '30 days') AS new_users_30d,
        (SELECT COUNT(*) FROM users WHERE is_suspended = TRUE)                   AS suspended_users,
        (SELECT COUNT(*) FROM documents WHERE is_deleted = FALSE)                AS total_documents,
        (SELECT COUNT(*) FROM documents WHERE status = 'signed')                 AS signed_documents,
        (SELECT COUNT(*) FROM documents WHERE created_at > NOW() - INTERVAL '7 days') AS docs_7d,
        (SELECT COUNT(*) FROM subscriptions s JOIN plans p ON p.id = s.plan_id
          WHERE s.status = 'active' AND p.name != 'free')                        AS paying_users,
        (SELECT COALESCE(SUM(p.price_usd), 0)
          FROM subscriptions s JOIN plans p ON p.id = s.plan_id
          WHERE s.status = 'active' AND p.name != 'free')                        AS mrr
    `);

    return res.json({ stats: result.rows[0] });
  } catch (err) {
    return res.status(500).json({ error: 'Could not fetch stats.' });
  }
});

// ── GET /api/admin/logs ───────────────────────────────────────────────────────
router.get('/logs', requirePermission('logs.read'), async (req, res) => {
  try {
    const { admin_id, action, page = 1, limit = 50 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);
    const params = [];
    let where = 'WHERE 1=1';

    if (admin_id) { params.push(admin_id); where += ` AND al.admin_id = $${params.length}`; }
    if (action)   { params.push(`%${action}%`); where += ` AND al.action ILIKE $${params.length}`; }

    params.push(parseInt(limit), offset);

    const result = await pool.query(
      `SELECT
         al.id, al.action, al.resource_type, al.resource_id,
         al.details, al.ip_address, al.created_at,
         a.email AS admin_email, ar.name AS admin_role
       FROM admin_logs al
       JOIN admins a ON a.id = al.admin_id
       JOIN admin_roles ar ON ar.id = a.role_id
       ${where}
       ORDER BY al.created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    return res.json({ logs: result.rows });
  } catch (err) {
    return res.status(500).json({ error: 'Could not fetch logs.' });
  }
});

module.exports = router;
