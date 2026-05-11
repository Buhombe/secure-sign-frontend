'use strict';

/**
 * fileService.js
 *
 * Single place for ALL file I/O in the application.
 * No route or controller should call fs directly.
 *
 * Security guarantees:
 *   1. Every filename stored in the DB is a UUID — no user input in filenames.
 *   2. Every file read uses path.basename() to strip traversal components.
 *   3. Every resolved path is verified to be inside UPLOADS_DIR before I/O.
 *   4. Magic-byte validation runs on every upload (cannot be spoofed by MIME).
 *   5. Files are served with security headers that prevent caching and sniffing.
 *   6. Orphaned temp files are cleaned up on any error path.
 */

const fs      = require('fs');
const path    = require('path');
const crypto  = require('crypto');
const { v4: uuidv4 } = require('uuid');
const { upload: uploadCfg } = require('../config/security');

// Absolute path to uploads directory — computed once at module load
const UPLOADS_DIR = path.resolve(path.join(__dirname, '../../uploads'));

// Ensure uploads directory exists at startup
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

// ── Path safety ───────────────────────────────────────────────────────────────

/**
 * Resolves a stored filename to an absolute path and verifies it is
 * inside UPLOADS_DIR.  Throws if any traversal is detected.
 *
 * @param  {string} storedFilename — filename as stored in DB (no directory components)
 * @returns {string} absolute path
 */
function safeResolvePath(storedFilename) {
  // path.basename strips everything before the last separator
  const safe    = path.basename(storedFilename);
  const absPath = path.resolve(path.join(UPLOADS_DIR, safe));

  // Must start with UPLOADS_DIR + separator to prevent escape
  if (!absPath.startsWith(UPLOADS_DIR + path.sep)) {
    throw Object.assign(
      new Error(`Path traversal detected: "${storedFilename}"`),
      { status: 400 }
    );
  }

  return absPath;
}

// ── Magic-byte PDF validation ─────────────────────────────────────────────────

/**
 * Reads first 5 bytes of a file and checks for %PDF- header.
 * This is called AFTER multer saves the file so we inspect real bytes,
 * not the client-supplied Content-Type.
 *
 * @param  {string} absPath — absolute path to file on disk
 * @returns {Promise<boolean>}
 */
async function validatePdfMagicBytes(absPath) {
  return new Promise((resolve, reject) => {
    const buf = Buffer.alloc(5);
    fs.open(absPath, 'r', (openErr, fd) => {
      if (openErr) return reject(openErr);
      fs.read(fd, buf, 0, 5, 0, (readErr) => {
        fs.close(fd, () => {});
        if (readErr) return reject(readErr);
        resolve(buf.equals(uploadCfg.pdfMagicBytes));
      });
    });
  });
}

// ── File naming ───────────────────────────────────────────────────────────────

/**
 * Generates a secure random filename for an uploaded PDF.
 * Format: <uuid>.pdf
 * The original filename is stored separately in documents.original_name
 * and is NEVER used as the storage name.
 */
function generatePdfFilename() {
  return `${uuidv4()}.pdf`;
}

/**
 * Generates a secure random filename for a signed PDF.
 * Format: signed-<uuid>.pdf
 */
function generateSignedPdfFilename() {
  return `signed-${uuidv4()}.pdf`;
}

/**
 * Generates a secure random filename for a profile photo.
 * Preserves extension (jpg/png/webp) for correct Content-Type serving.
 */
function generatePhotoFilename(originalName) {
  const ext = path.extname(originalName).toLowerCase().replace(/[^.a-z]/g, '');
  return `photo-${uuidv4()}${ext}`;
}

// ── SHA-256 checksum ──────────────────────────────────────────────────────────

/**
 * Computes SHA-256 checksum of a file.
 * Stored alongside documents so integrity can be verified later.
 */
function computeFileHash(absPath) {
  return new Promise((resolve, reject) => {
    const hash   = crypto.createHash('sha256');
    const stream = fs.createReadStream(absPath);
    stream.on('data', chunk => hash.update(chunk));
    stream.on('end',  ()    => resolve(hash.digest('hex')));
    stream.on('error', err  => reject(err));
  });
}

// ── Safe file existence check ─────────────────────────────────────────────────

function fileExists(storedFilename) {
  try {
    const absPath = safeResolvePath(storedFilename);
    return fs.existsSync(absPath);
  } catch {
    return false;
  }
}

// ── Safe delete ───────────────────────────────────────────────────────────────

/**
 * Best-effort delete — logs but never throws.
 * Used for cleanup after signing (original file) and error paths.
 */
function safeDelete(storedFilename) {
  try {
    const absPath = safeResolvePath(storedFilename);
    if (fs.existsSync(absPath)) {
      fs.unlinkSync(absPath);
    }
  } catch (err) {
    console.error(`[fileService] Failed to delete "${storedFilename}":`, err.message);
  }
}

// ── Secure file response ──────────────────────────────────────────────────────

/**
 * Streams a file to the HTTP response with security headers.
 *
 * Security headers applied:
 *   - Content-Type: application/pdf (explicit, not sniffed)
 *   - Content-Disposition: attachment (forces download, prevents inline execution)
 *   - Cache-Control: no-store (sensitive docs must not be cached)
 *   - X-Content-Type-Options: nosniff (belt-and-suspenders)
 *
 * @param  {object} res            — Express response object
 * @param  {string} storedFilename — filename as stored in DB
 * @param  {string} originalName   — user-facing filename for Content-Disposition
 * @returns {boolean} false if file not found (caller should return 404)
 */
function streamFileToResponse(res, storedFilename, originalName) {
  let absPath;
  try {
    absPath = safeResolvePath(storedFilename);
  } catch {
    return false;
  }

  if (!fs.existsSync(absPath)) return false;

  // Sanitise originalName for Content-Disposition header
  // RFC 5987 percent-encoding for non-ASCII characters
  const safeName = encodeURIComponent(
    originalName.replace(/[^\w\s.\-()]/g, '_')
  );

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${safeName}"; filename*=UTF-8''${safeName}`);
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('X-Content-Type-Options', 'nosniff');

  fs.createReadStream(absPath).pipe(res);
  return true;
}

// ── Multer storage config ─────────────────────────────────────────────────────

/**
 * Returns a multer diskStorage config that uses UUID filenames.
 * The calling route passes the filename generator function.
 */
function makeMulterStorage(filenameGenerator) {
  const multer = require('multer');
  return multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOADS_DIR),
    filename:    (req, file, cb) => cb(null, filenameGenerator(file.originalname)),
  });
}

module.exports = {
  UPLOADS_DIR,
  safeResolvePath,
  validatePdfMagicBytes,
  generatePdfFilename,
  generateSignedPdfFilename,
  generatePhotoFilename,
  computeFileHash,
  fileExists,
  safeDelete,
  streamFileToResponse,
  makeMulterStorage,
};