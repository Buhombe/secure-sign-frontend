'use strict';

const cloudinary   = require('cloudinary').v2;
const streamifier  = require('streamifier');
const https        = require('https');
const http         = require('http');

// Configure Cloudinary
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const FOLDER       = process.env.CLOUDINARY_FOLDER || 'securesign/documents';
const PHOTO_FOLDER = `${process.env.CLOUDINARY_FOLDER || 'securesign'}/photos`;

// ── Document upload / delete ──────────────────────────────────────────────────

async function uploadDocument(fileBuffer, publicId) {
  if (!Buffer.isBuffer(fileBuffer) || fileBuffer.length === 0) {
    throw new Error('uploadDocument: fileBuffer must be a non-empty Buffer.');
  }

  return new Promise((resolve, reject) => {
    const uploadStream = cloudinary.uploader.upload_stream(
      {
        resource_type: 'raw',
        folder: FOLDER,
        public_id: publicId,
        overwrite: true,
      },
      (error, result) => {
        if (error) return reject(new Error(`Cloudinary upload failed: ${error.message}`));
        console.log(`[storageService] Uploaded to Cloudinary → ${result.public_id}`);
        resolve({
          url:      result.secure_url,
          publicId: result.public_id,
        });
      }
    );
    streamifier.createReadStream(fileBuffer).pipe(uploadStream);
  });
}

async function deleteDocument(publicId) {
  if (!publicId) return;
  try {
    await cloudinary.uploader.destroy(publicId, { resource_type: 'raw' });
    console.log(`[storageService] Deleted from Cloudinary: ${publicId}`);
  } catch (err) {
    console.error('[storageService] Delete failed:', err.message);
  }
}

// ── Profile photo upload / delete ─────────────────────────────────────────────

/**
 * Uploads a profile photo buffer to Cloudinary under the photos folder.
 * Returns { url, publicId }.
 */
async function uploadPhoto(fileBuffer, publicId) {
  if (!Buffer.isBuffer(fileBuffer) || fileBuffer.length === 0) {
    throw new Error('uploadPhoto: fileBuffer must be a non-empty Buffer.');
  }

  return new Promise((resolve, reject) => {
    const uploadStream = cloudinary.uploader.upload_stream(
      {
        resource_type: 'image',
        folder: PHOTO_FOLDER,
        public_id: publicId,
        overwrite: true,
      },
      (error, result) => {
        if (error) return reject(new Error(`Cloudinary photo upload failed: ${error.message}`));
        console.log(`[storageService] Photo uploaded → ${result.public_id}`);
        resolve({
          url:      result.secure_url,
          publicId: result.public_id,
        });
      }
    );
    streamifier.createReadStream(fileBuffer).pipe(uploadStream);
  });
}

/**
 * Deletes a profile photo from Cloudinary.
 * Accepts either a full Cloudinary URL or a raw publicId.
 * For URLs, extracts the publicId automatically.
 * Best-effort — never throws.
 */
async function deletePhoto(urlOrPublicId) {
  if (!urlOrPublicId) return;
  try {
    let publicId = urlOrPublicId;
    if (urlOrPublicId.startsWith('http')) {
      // Extract publicId from Cloudinary URL:
      // https://res.cloudinary.com/cloud/image/upload/v123/folder/file.jpg
      // → publicId = folder/file  (no extension)
      const match = urlOrPublicId.match(/\/upload\/(?:v\d+\/)?(.+?)(?:\.[^.]+)?$/);
      if (!match) return;
      publicId = match[1];
    }
    await cloudinary.uploader.destroy(publicId, { resource_type: 'image' });
    console.log(`[storageService] Photo deleted: ${publicId}`);
  } catch (err) {
    console.error('[storageService] Photo delete failed:', err.message);
  }
}

// ── Signed URL (for deprecated download endpoint) ─────────────────────────────

function getSignedUrl(publicId, expiresInSeconds = 3600) {
  return cloudinary.url(publicId, {
    resource_type: 'raw',
    type:          'upload',
    secure:        true,
    sign_url:      true,
    expires_at:    Math.floor(Date.now() / 1000) + expiresInSeconds,
  });
}

// ── PDF stream proxy ───────────────────────────────────────────────────────────

function extractPublicId(fileUrl) {
  // e.g. https://res.cloudinary.com/cloud/raw/upload/v123/securesign/documents/abc.pdf
  //   -> securesign/documents/abc
  const match = fileUrl.match(/\/upload\/(?:v\d+\/)?(.+?)(?:\.[^./]+)?$/);
  return match ? match[1] : null;
}

function streamToResponse(fileUrl, res) {
  return new Promise((resolve, reject) => {
    let url;

    if (!fileUrl || !fileUrl.startsWith('http')) {
      // Legacy local path
      const filename = (fileUrl || '').split('/').pop();
      const publicId = `${FOLDER}/${filename.replace(/\.pdf$/i, '')}`;
      url = getSignedUrl(publicId, 3600);
      console.log(`[storageService] Legacy path, signing: ${publicId}`);
    } else {
      // Always generate a fresh signed URL from the stored secure_url
      const publicId = extractPublicId(fileUrl);
      if (publicId) {
        url = getSignedUrl(publicId, 3600);
        console.log(`[storageService] Signing URL for publicId: ${publicId}`);
      } else {
        url = fileUrl;
        console.warn(`[storageService] Could not extract publicId, using raw URL`);
      }
    }

    const protocol = url.startsWith('https') ? https : http;
    protocol.get(url, (cloudRes) => {
      if (cloudRes.statusCode !== 200) {
        console.error(`[storageService] Cloudinary returned HTTP ${cloudRes.statusCode}`);
        return reject(new Error(`Failed to fetch file: HTTP ${cloudRes.statusCode}`));
      }
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', 'inline');
      cloudRes.pipe(res);
      cloudRes.on('end', resolve);
      cloudRes.on('error', reject);
    }).on('error', reject);
  });
}

module.exports = {
  uploadDocument,
  deleteDocument,
  uploadPhoto,
  deletePhoto,
  getSignedUrl,
  streamToResponse,
};
