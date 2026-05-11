'use strict';

const express  = require('express');
const router   = express.Router();
const bcrypt   = require('bcryptjs');
const pool     = require('../config/database');
const { issueAdminToken } = require('../services/adminTokenService');
const { adminAuth, logAdminAction } = require('../middleware/adminAuth');
const { adminLimiter } = require('../middleware/rateLimiter');

// ── POST /api/admin/auth/login ────────────────────────────────────────────────
router.post('/login', adminLimiter, async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required.' });
  }

  try {
    const result = await pool.query(
      `SELECT a.*, r.name AS role_name, r.permissions
       FROM admins a
       JOIN admin_roles r ON r.id = a.role_id
       WHERE a.email = $1`,
      [email.toLowerCase().trim()]
    );

    const admin = result.rows[0];
    const DUMMY = '$2a$12$invalidhashvaluethatnevermatchesXXXXXXXXXXXXXXXXXXXXXX';
    const match = await bcrypt.compare(password, admin?.password_hash || DUMMY);

    if (!admin || !match || !admin.is_active) {
      return res.status(401).json({ error: 'Invalid credentials.' });
    }

    // Update last login
    await pool.query(
      `UPDATE admins SET last_login_at = NOW(), last_login_ip = $1 WHERE id = $2`,
      [req.ip, admin.id]
    );

    await logAdminAction(admin.id, 'ADMIN_LOGIN', null, null, { ip: req.ip }, req);

    const token = issueAdminToken({
      id:          admin.id,
      email:       admin.email,
      role_name:   admin.role_name,
      permissions: admin.permissions,
    });

    return res.json({
      token,
      admin: {
        id:    admin.id,
        email: admin.email,
        role:  admin.role_name,
      },
    });
  } catch (err) {
    console.error('Admin login error:', err.message);
    return res.status(500).json({ error: 'Login failed.' });
  }
});

// ── POST /api/admin/auth/logout ───────────────────────────────────────────────
router.post('/logout', adminAuth, async (req, res) => {
  await logAdminAction(req.admin.id, 'ADMIN_LOGOUT', null, null, null, req);
  return res.json({ message: 'Logged out.' });
});

// ── GET /api/admin/auth/me ────────────────────────────────────────────────────
router.get('/me', adminAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT a.id, a.email, a.last_login_at, a.last_login_ip,
              r.name AS role, r.permissions
       FROM admins a JOIN admin_roles r ON r.id = a.role_id
       WHERE a.id = $1`,
      [req.admin.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Admin not found.' });
    return res.json({ admin: result.rows[0] });
  } catch (err) {
    return res.status(500).json({ error: 'Could not fetch admin.' });
  }
});

module.exports = router;
