/**
 * createAdmin.js — Run once to create your first super admin
 * Usage: node createAdmin.js
 */
'use strict';

require('dotenv').config();
const bcrypt = require('bcryptjs');
const pool   = require('./src/config/database');

const ADMIN_EMAIL    = process.env.ADMIN_EMAIL    || 'mbuhombe@gmail.com';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'Admin@SecureSign2026!';

async function main() {
  try {
    const roleResult = await pool.query(
      `SELECT id FROM admin_roles WHERE name = 'super_admin'`
    );

    if (!roleResult.rows[0]) {
      console.error('Run migrate_admin.sql first!');
      process.exit(1);
    }

    const hash = await bcrypt.hash(ADMIN_PASSWORD, 12);

    await pool.query(
      `INSERT INTO admins (email, password_hash, role_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (email) DO UPDATE SET password_hash = $2`,
      [ADMIN_EMAIL, hash, roleResult.rows[0].id]
    );

    console.log(`✅ Super admin created: ${ADMIN_EMAIL}`);
    console.log(`🔑 Password: ${ADMIN_PASSWORD}`);
    console.log(`⚠️  Change this password after first login!`);
    process.exit(0);
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  }
}

main();
