'use strict';

/**
 * cryptoSigningService.js
 *
 * RSA-2048 + SHA-256 document signing.
 *
 * Sign:   RSA-PSS sign over SHA-256(pdfBytes) — signature stored as hex
 * Verify: RSA-PSS verify signature against SHA-256(pdfBytes)
 *
 * Both sign and verify operate over the SAME data: original PDF bytes.
 * The stored document_hash is the SHA-256 hex of those bytes — used as
 * a quick tamper check and for display, not for crypto verification.
 */

const crypto  = require('crypto');
const { encrypt, decrypt } = require('./encryptionService');

const RSA_KEY_BITS = 2048;
const PSS_OPTIONS  = {
  padding:    crypto.constants.RSA_PKCS1_PSS_PADDING,
  saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
};

// ── Key generation ────────────────────────────────────────────────────────────
async function generateUserKeyPair() {
  return new Promise((resolve, reject) => {
    crypto.generateKeyPair(
      'rsa',
      {
        modulusLength:      RSA_KEY_BITS,
        publicKeyEncoding:  { type: 'spki',  format: 'pem' },
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      },
      (err, publicKey, privateKey) => {
        if (err) return reject(err);
        resolve({
          publicKeyPem:       publicKey,
          encryptedPrivateKey: encrypt(privateKey),
        });
      }
    );
  });
}

// ── Hash ──────────────────────────────────────────────────────────────────────
function hashDocument(pdfBytes) {
  return crypto.createHash('sha256').update(pdfBytes).digest('hex');
}

// ── Sign ──────────────────────────────────────────────────────────────────────
/**
 * Signs the PDF bytes with the user's RSA private key.
 * Returns { documentHash, signature } — both hex strings.
 * documentHash = SHA-256 of pdfBytes (stored for display/quick check)
 * signature    = RSA-PSS over pdfBytes (stored for cryptographic proof)
 */
function signDocument(pdfBytes, encryptedPrivateKey) {
  const privateKeyPem = decrypt(encryptedPrivateKey);
  const documentHash  = hashDocument(pdfBytes);

  const signer = crypto.createSign('SHA256');
  signer.update(pdfBytes);
  signer.end();

  const signature = signer.sign(
    { key: privateKeyPem, ...PSS_OPTIONS },
    'hex'
  );

  return { documentHash, signature };
}

// ── Verify ────────────────────────────────────────────────────────────────────
/**
 * Verifies a document signature.
 *
 * IMPORTANT: pdfBytes here must be the ORIGINAL PDF bytes (before stamping),
 * not the signed PDF. We store the original bytes' hash but not the bytes
 * themselves. See verifyFromHash() for the approach we use in practice.
 */
function verifyDocument(pdfBytes, signatureHex, publicKeyPem) {
  try {
    const verifier = crypto.createVerify('SHA256');
    verifier.update(pdfBytes);
    verifier.end();

    const valid = verifier.verify(
      { key: publicKeyPem, ...PSS_OPTIONS },
      signatureHex,
      'hex'
    );

    return { valid, reason: valid
      ? 'Signature valid. Document is authentic.'
      : 'Signature invalid. Document may have been tampered with.' };
  } catch (err) {
    return { valid: false, reason: `Verification error: ${err.message}` };
  }
}

// ── Key fingerprint ───────────────────────────────────────────────────────────
function publicKeyFingerprint(publicKeyPem) {
  const der = crypto.createPublicKey(publicKeyPem).export({ type: 'spki', format: 'der' });
  return crypto.createHash('sha256').update(der).digest('hex');
}

module.exports = {
  generateUserKeyPair,
  hashDocument,
  signDocument,
  verifyDocument,
  publicKeyFingerprint,
};