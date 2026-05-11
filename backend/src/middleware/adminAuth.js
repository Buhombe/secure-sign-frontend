'use strict';

const { verifyAdminToken } = require('../services/adminTokenService');
const pool = require('../config/database');

// ── Authenticate admin from Bearer token ──────────────────────────────────────
function adminAuth(req, res, next) {
  const authHeader = req.headers['authorization'];
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Admin authentication required.' });
  }
  try {
    req.admin = verifyAdminToken(authHeader.slice(7));
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Admin session expired. Please login again.', code: 'TOKEN_EXPIRED' });
    }
    return res.status(403).json({ error: 'Invalid admin token.' });
  }
}

// ── RBAC: check permission ─────────────────────────────────────────────────────
function requirePermission(permission) {
  return (req, res, next) => {
    const perms = req.admin?.perms || [];
    if (perms.includes('*') || perms.includes(permission)) return next();
    return res.status(403).json({
      error: `Permission denied. Required: ${permission}`,
      code: 'PERMISSION_DENIED',
    });
  };
}

// ── Log every admin action ────────────────────────────────────────────────────
async function logAdminAction(adminId, action, resourceType, resourceId, details, req) {
  try {
    await pool.query(
      `INSERT INTO admin_logs
         (admin_id, action, resource_type, resource_id, details, ip_address, user_agent)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [
        adminId, action, resourceType || null, resourceId || null,
        details ? JSON.stringify(details) : null,
        req?.ip || null,
        req?.headers?.['user-agent']?.slice(0, 200) || null,
      ]
    );
  } catch (err) {
    console.error('[adminLog] Failed to log action:', err.message);
  }
}

module.exports = { adminAuth, requirePermission, logAdminAction };
