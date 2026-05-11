require('dotenv').config();
const { Pool } = require('pg');
const cloudinary = require('cloudinary').v2;

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const pool = new Pool({
  host: process.env.DB_HOST, port: process.env.DB_PORT,
  database: process.env.DB_NAME, user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
});

async function fixUrls() {
  const result = await pool.query(
    'SELECT id, cloudinary_public_id FROM documents WHERE cloudinary_public_id IS NOT NULL AND is_deleted = FALSE'
  );
  
  for (const row of result.rows) {
    // Generate signed URL valid for 1 year
    const signedUrl = cloudinary.url(row.cloudinary_public_id, {
      resource_type: 'raw',
      type: 'upload',
      secure: true,
      sign_url: true,
      expires_at: Math.floor(Date.now() / 1000) + (365 * 24 * 60 * 60),
    });
    await pool.query('UPDATE documents SET file_path = $1 WHERE id = $2', [signedUrl, row.id]);
    console.log('Fixed:', row.id);
    console.log('URL:', signedUrl);
  }
  
  await pool.end();
  console.log('Done!');
}

fixUrls().catch(console.error);
