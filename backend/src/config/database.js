const { Pool } = require('pg');
require('dotenv').config();

// ── SSL configuration ─────────────────────────────────────────────────────────
// If DB_SSL_CERT is set (Railway CA cert, base64 or PEM string), we use it
// with rejectUnauthorized: true for full certificate verification.
// If not set, we fall back to rejectUnauthorized: false and log a warning.
// To fix: get your DB CA cert from Railway dashboard → Variables → show
// DATABASE_URL, then set DB_SSL_CERT to the CA cert content.
function buildSslConfig() {
  if (process.env.NODE_ENV !== 'production') return false;

  if (process.env.DB_SSL_CERT) {
    return {
      rejectUnauthorized: true,
      ca: process.env.DB_SSL_CERT,
    };
  }

  console.warn(
    '[database] WARNING: DB_SSL_CERT not set — using rejectUnauthorized: false. ' +
    'Set DB_SSL_CERT to your Railway PostgreSQL CA certificate to enable full SSL verification.'
  );
  return { rejectUnauthorized: false };
}

// ─────────────────────────────────────────────────────────────────────────────

// Railway provides DATABASE_URL; fallback to individual vars for local dev
const pool = process.env.DATABASE_URL
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: buildSslConfig(),
    })
  : new Pool({
      host:     process.env.DB_HOST,
      port:     process.env.DB_PORT,
      database: process.env.DB_NAME,
      user:     process.env.DB_USER,
      password: process.env.DB_PASSWORD,
    });

pool.connect((err, client, release) => {
  if (err) {
    console.error('❌ Database connection failed:', err.message);
  } else {
    console.log('✅ Connected to PostgreSQL database');
    release();
  }
});

module.exports = pool;
