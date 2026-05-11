'use strict';

const jwt    = require('jsonwebtoken');
const crypto = require('crypto');

const ADMIN_JWT_SECRET  = process.env.ADMIN_JWT_SECRET || process.env.JWT_SECRET;
const ADMIN_JWT_EXPIRES = '8h'; // Admin sessions expire faster

if (!ADMIN_JWT_SECRET) {
  throw new Error('FATAL: ADMIN_JWT_SECRET is not set.');
}

function issueAdminToken(admin) {
  return jwt.sign(
    {
      id:    admin.id,
      email: admin.email,
      role:  admin.role_name,
      perms: admin.permissions,
      type:  'admin',
    },
    ADMIN_JWT_SECRET,
    { expiresIn: ADMIN_JWT_EXPIRES, issuer: 'secure-sign-admin' }
  );
}

function verifyAdminToken(token) {
  const decoded = jwt.verify(token, ADMIN_JWT_SECRET, { issuer: 'secure-sign-admin' });
  if (decoded.type !== 'admin') throw new Error('Not an admin token.');
  return decoded;
}

module.exports = { issueAdminToken, verifyAdminToken };
