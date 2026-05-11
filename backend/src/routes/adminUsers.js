'use strict';

const express = require('express');
const router  = express.Router();
const pool    = require('../config/database');
const { adminAuth, requirePermission, logAdminAction } = require('../middleware/adminAuth');

// All routes require admin auth
router.use(adminAuth);

// ── GET /api/admin/users ──────────────────────────────────────────────────────
router.get('/', requirePermission('users.read'), async (req, res) => {
  try {
    const { search, plan, status, page = 1, limit = 20 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);

    const params = [];
    let where = 'WHERE u.is_deleted = FALSE';

    if (search) {
      params.push(`%${search.toLowerCase()}%`);
      where += ` AND LOWER(u.email) LIKE $${params.length}`;
    }
    if (plan) {
      params.push(plan);
      where += ` AND p.name = $${params.length}`;
    }
    if (status === 'suspended') where += ` AND u.is_suspended = TRUE`;
    if (status === 'active')    where += ` AND u.is_suspended = FALSE`;

    params.push(parseInt(limit), offset);

    const [usersResult, countResult] = await Promise.all([
      pool.query(
        `SELECT
           u.id, u.email, u.created_at, u.is_suspended, u.suspend_reason,
           u.mfa_enabled, u.last_login_at,
           p.name AS plan_name, p.price_usd,
           s.status AS sub_status, s.current_period_end,
           COUNT(DISTINCT d.id) FILTER (WHERE d.is_deleted = FALSE) AS total_docs,
           COUNT(DISTINCT d.id) FILTER (WHERE d.status = 'signed') AS signed_docs
         FROM users u
         LEFT JOIN subscriptions s ON s.user_id = u.id
         LEFT JOIN plans p ON p.id = s.plan_id
         LEFT JOIN documents d ON d.user_id = u.id
         ${where}
         GROUP BY u.id, p.name, p.price_usd, s.status, s.current_period_end
         ORDER BY u.created_at DESC
         LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params
      ),
      pool.query(
        `SELECT COUNT(*) FROM users u
         LEFT JOIN subscriptions s ON s.user_id = u.id
         LEFT JOIN plans p ON p.id = s.plan_id
         ${where}`,
        params.slice(0, -2)
      ),
    ]);

    return res.json({
      users: usersResult.rows,
      total: parseInt(countResult.rows[0].count),
      page: parseInt(page),
      limit: parseInt(limit),
    });
  } catch (err) {
    console.error('Admin users error:', err.message);
    return res.status(500).json({ error: 'Could not fetch users.' });
  }
});

// ── GET /api/admin/users/:id ──────────────────────────────────────────────────
router.get('/:id', requirePermission('users.read'), async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT
         u.id, u.email, u.created_at, u.is_suspended, u.suspend_reason,
         u.suspended_at, u.mfa_enabled, u.failed_attempts,
         p.name AS plan_name, p.price_usd,
         s.status AS sub_status, s.current_period_end,
         COUNT(DISTINCT d.id) FILTER (WHERE d.is_deleted = FALSE) AS total_docs,
         COUNT(DISTINCT d.id) FILTER (WHERE d.status = 'signed') AS signed_docs,
         COUNT(DISTINCT sig.id) AS total_signatures
       FROM users u
       LEFT JOIN subscriptions s ON s.user_id = u.id
       LEFT JOIN plans p ON p.id = s.plan_id
       LEFT JOIN documents d ON d.user_id = u.id
       LEFT JOIN signatures sig ON sig.user_id = u.id
       WHERE u.id = $1 AND u.is_deleted = FALSE
       GROUP BY u.id, p.name, p.price_usd, s.status, s.current_period_end`,
      [req.params.id]
    );

    if (!result.rows[0]) return res.status(404).json({ error: 'User not found.' });

    // Recent activity
    const activity = await pool.query(
      `SELECT action, timestamp, ip_address FROM audit_logs
       WHERE user_id = $1 ORDER BY timestamp DESC LIMIT 10`,
      [req.params.id]
    );

    return res.json({ user: result.rows[0], activity: activity.rows });
  } catch (err) {
    return res.status(500).json({ error: 'Could not fetch user.' });
  }
});

// ── PATCH /api/admin/users/:id/suspend ───────────────────────────────────────
router.patch('/:id/suspend', requirePermission('users.suspend'), async (req, res) => {
  const { reason } = req.body;
  if (!reason?.trim()) return res.status(400).json({ error: 'Suspend reason is required.' });

  try {
    const result = await pool.query(
      `UPDATE users SET
         is_suspended   = TRUE,
         suspended_at   = NOW(),
         suspend_reason = $1
       WHERE id = $2 AND is_deleted = FALSE
       RETURNING id, email`,
      [reason.trim(), req.params.id]
    );

    if (!result.rows[0]) return res.status(404).json({ error: 'User not found.' });

    // Revoke all tokens immediately
    await pool.query(
      `UPDATE refresh_tokens SET revoked = TRUE WHERE user_id = $1`,
      [req.params.id]
    );

    await logAdminAction(req.admin.id, 'USER_SUSPENDED', 'user', req.params.id, { reason }, req);

    return res.json({ message: `User ${result.rows[0].email} suspended.` });
  } catch (err) {
    return res.status(500).json({ error: 'Could not suspend user.' });
  }
});

// ── PATCH /api/admin/users/:id/unsuspend ─────────────────────────────────────
router.patch('/:id/unsuspend', requirePermission('users.suspend'), async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE users SET is_suspended = FALSE, suspended_at = NULL, suspend_reason = NULL
       WHERE id = $1 AND is_deleted = FALSE RETURNING id, email`,
      [req.params.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'User not found.' });

    await logAdminAction(req.admin.id, 'USER_UNSUSPENDED', 'user', req.params.id, null, req);
    return res.json({ message: `User ${result.rows[0].email} unsuspended.` });
  } catch (err) {
    return res.status(500).json({ error: 'Could not unsuspend user.' });
  }
});

// ── PATCH /api/admin/users/:id/plan ──────────────────────────────────────────
router.patch('/:id/plan', requirePermission('users.plan'), async (req, res) => {
  const { plan_name, days = 30 } = req.body;
  if (!plan_name) return res.status(400).json({ error: 'plan_name is required.' });

  try {
    const plan = await pool.query('SELECT id FROM plans WHERE name = $1', [plan_name]);
    if (!plan.rows[0]) return res.status(404).json({ error: `Plan '${plan_name}' not found.` });

    const periodEnd = new Date(Date.now() + days * 86400000);

    await pool.query(
      `INSERT INTO subscriptions (user_id, plan_id, status, current_period_end)
       VALUES ($1,$2,'active',$3)
       ON CONFLICT (user_id) DO UPDATE SET
         plan_id = $2, status = 'active',
         current_period_end = $3, updated_at = NOW()`,
      [req.params.id, plan.rows[0].id, periodEnd]
    );

    await logAdminAction(req.admin.id, 'USER_PLAN_CHANGED', 'user', req.params.id, { plan_name, days }, req);
    return res.json({ message: `Plan changed to ${plan_name} for ${days} days.` });
  } catch (err) {
    return res.status(500).json({ error: 'Could not change plan.' });
  }
});

// ── DELETE /api/admin/users/:id — SOFT DELETE ONLY ───────────────────────────
router.delete('/:id', requirePermission('users.delete'), async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE users SET is_deleted = TRUE, deleted_at = NOW()
       WHERE id = $1 AND is_deleted = FALSE RETURNING id, email`,
      [req.params.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'User not found.' });

    await pool.query(`UPDATE refresh_tokens SET revoked = TRUE WHERE user_id = $1`, [req.params.id]);
    await logAdminAction(req.admin.id, 'USER_DELETED', 'user', req.params.id, { email: result.rows[0].email }, req);

    return res.json({ message: 'User soft-deleted.' });
  } catch (err) {
    return res.status(500).json({ error: 'Could not delete user.' });
  }
});

module.exports = router;
