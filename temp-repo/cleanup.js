const { Pool } = require('pg');
require('dotenv').config();
const pool = new Pool();
const fs = require('fs');
const path = require('path');

pool.query('SELECT id, file_path FROM documents').then(r => {
  const toDelete = r.rows.filter(d => {
    const fp = path.join(__dirname, 'uploads', d.file_path);
    return !fs.existsSync(fp);
  });
  console.log('Records without files:', toDelete.length);
  if (toDelete.length === 0) { pool.end(); return; }
  const ids = toDelete.map(d => d.id);
  pool.query('DELETE FROM documents WHERE id = ANY($1)', [ids]).then(del => {
    console.log('Deleted:', del.rowCount, 'records');
    pool.end();
  });
});
