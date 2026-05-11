'use strict';

const { Resend } = require('resend');

if (!process.env.RESEND_API_KEY) {
  throw new Error('FATAL: RESEND_API_KEY environment variable is not set.');
}

const resend = new Resend(process.env.RESEND_API_KEY);

const FROM_ADDRESS = process.env.EMAIL_FROM || 'SecureSign <noreply@securesign.app>';
const BASE_URL     = process.env.BASE_URL   || 'http://localhost:3000';

// ── Minimal HTML escape ───────────────────────────────────────────────────────
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

// ── Shared email wrapper ──────────────────────────────────────────────────────
function wrapHtml(title, bodyHtml) {
  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
</head>
<body style="margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f4f4f5;">
  <table width="100%" cellpadding="0" cellspacing="0" style="padding:40px 20px;">
    <tr>
      <td align="center">
        <table width="560" cellpadding="0" cellspacing="0"
               style="background:#ffffff;border-radius:8px;overflow:hidden;
                      box-shadow:0 1px 3px rgba(0,0,0,0.12);">
          <!-- Header -->
          <tr>
            <td style="background:#1a1a2e;padding:28px 40px;">
              <p style="margin:0;color:#ffffff;font-size:20px;font-weight:700;
                         letter-spacing:-0.3px;">✍️ SecureSign</p>
            </td>
          </tr>
          <!-- Body -->
          <tr>
            <td style="padding:40px 40px 32px;">
              ${bodyHtml}
            </td>
          </tr>
          <!-- Footer -->
          <tr>
            <td style="padding:20px 40px 32px;border-top:1px solid #e5e7eb;">
              <p style="margin:0;color:#9ca3af;font-size:12px;line-height:1.5;">
                This email was sent by SecureSign. If you were not expecting it, you can safely ignore it.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`.trim();
}

// ── Send signing request email ────────────────────────────────────────────────
async function sendSigningEmail(recipientEmail, signingLink, documentName = 'a document') {
  const subject = 'Document Signing Request';

  const html = wrapHtml(subject, `
    <h1 style="margin:0 0 16px;color:#111827;font-size:22px;font-weight:700;">
      You have a document to sign
    </h1>
    <p style="margin:0 0 24px;color:#374151;font-size:15px;line-height:1.6;">
      You've been asked to review and sign <strong>${escapeHtml(documentName)}</strong>.
      Please click the button below to open the document and add your signature.
    </p>
    <p style="margin:0 0 32px;color:#374151;font-size:15px;line-height:1.6;">
      This link is unique to you and expires in
      <strong>${process.env.RECIPIENT_TOKEN_EXPIRY_HOURS || 72} hours</strong>.
      Do not share it with others.
    </p>
    <table cellpadding="0" cellspacing="0">
      <tr>
        <td style="border-radius:6px;background:#2563eb;">
          <a href="${signingLink}"
             style="display:inline-block;padding:14px 32px;color:#ffffff;
                    font-size:15px;font-weight:600;text-decoration:none;border-radius:6px;">
            Review &amp; Sign Document →
          </a>
        </td>
      </tr>
    </table>
    <p style="margin:28px 0 0;color:#6b7280;font-size:13px;line-height:1.5;">
      If the button doesn't work, copy and paste this link into your browser:<br>
      <a href="${signingLink}" style="color:#2563eb;word-break:break-all;">${signingLink}</a>
    </p>
  `);

  const text = [
    `Document Signing Request`,
    ``,
    `You have been asked to sign: ${documentName}`,
    ``,
    `Please visit the link below to review and sign the document:`,
    signingLink,
    ``,
    `This link expires in ${process.env.RECIPIENT_TOKEN_EXPIRY_HOURS || 72} hours.`,
    `Do not share it with others.`,
  ].join('\n');

  const { data, error } = await resend.emails.send({
    from: FROM_ADDRESS, to: recipientEmail, subject, html, text,
  });

  if (error) throw new Error(`Email delivery failed: ${error.message}`);
  console.log(`[emailService] Signing email sent → ${recipientEmail} (id: ${data.id})`);
  return { id: data.id };
}

// ── Send email verification email ─────────────────────────────────────────────
async function sendVerificationEmail(recipientEmail, verifyLink) {
  const subject = 'Verify your SecureSign email address';

  const html = wrapHtml(subject, `
    <h1 style="margin:0 0 16px;color:#111827;font-size:22px;font-weight:700;">
      Verify your email address
    </h1>
    <p style="margin:0 0 24px;color:#374151;font-size:15px;line-height:1.6;">
      Welcome to SecureSign! Please verify your email address to activate your account.
      This link expires in <strong>24 hours</strong>.
    </p>
    <table cellpadding="0" cellspacing="0" style="margin-bottom:32px;">
      <tr>
        <td style="border-radius:6px;background:#16a34a;">
          <a href="${verifyLink}"
             style="display:inline-block;padding:14px 32px;color:#ffffff;
                    font-size:15px;font-weight:600;text-decoration:none;border-radius:6px;">
            Verify Email Address →
          </a>
        </td>
      </tr>
    </table>
    <p style="margin:0;color:#6b7280;font-size:13px;line-height:1.5;">
      If the button doesn't work, copy and paste this link into your browser:<br>
      <a href="${verifyLink}" style="color:#2563eb;word-break:break-all;">${verifyLink}</a>
    </p>
  `);

  const text = [
    `Verify your SecureSign email address`,
    ``,
    `Welcome to SecureSign! Please verify your email by visiting:`,
    verifyLink,
    ``,
    `This link expires in 24 hours.`,
    `If you didn't create this account, you can safely ignore this email.`,
  ].join('\n');

  const { data, error } = await resend.emails.send({
    from: FROM_ADDRESS, to: recipientEmail, subject, html, text,
  });

  if (error) throw new Error(`Verification email failed: ${error.message}`);
  console.log(`[emailService] Verification email sent → ${recipientEmail} (id: ${data.id})`);
  return { id: data.id };
}

// ── Send password reset email ─────────────────────────────────────────────────
async function sendPasswordResetEmail(recipientEmail, resetLink) {
  const subject = 'Reset your SecureSign password';

  const html = wrapHtml(subject, `
    <h1 style="margin:0 0 16px;color:#111827;font-size:22px;font-weight:700;">
      Reset your password
    </h1>
    <p style="margin:0 0 24px;color:#374151;font-size:15px;line-height:1.6;">
      We received a request to reset your SecureSign password.
      Click the button below to set a new password. This link expires in <strong>1 hour</strong>.
    </p>
    <table cellpadding="0" cellspacing="0" style="margin-bottom:32px;">
      <tr>
        <td style="border-radius:6px;background:#dc2626;">
          <a href="${resetLink}"
             style="display:inline-block;padding:14px 32px;color:#ffffff;
                    font-size:15px;font-weight:600;text-decoration:none;border-radius:6px;">
            Reset Password →
          </a>
        </td>
      </tr>
    </table>
    <p style="margin:0 0 16px;color:#6b7280;font-size:13px;line-height:1.5;">
      If the button doesn't work, copy and paste this link into your browser:<br>
      <a href="${resetLink}" style="color:#2563eb;word-break:break-all;">${resetLink}</a>
    </p>
    <p style="margin:0;color:#6b7280;font-size:13px;">
      If you didn't request a password reset, you can safely ignore this email.
      Your password will not be changed.
    </p>
  `);

  const text = [
    `Reset your SecureSign password`,
    ``,
    `We received a request to reset your password. Visit the link below:`,
    resetLink,
    ``,
    `This link expires in 1 hour.`,
    `If you didn't request this, you can safely ignore this email.`,
  ].join('\n');

  const { data, error } = await resend.emails.send({
    from: FROM_ADDRESS, to: recipientEmail, subject, html, text,
  });

  if (error) throw new Error(`Password reset email failed: ${error.message}`);
  console.log(`[emailService] Password reset email sent → ${recipientEmail} (id: ${data.id})`);
  return { id: data.id };
}

// ── Send completion notification ─────────────────────────────────────────────
// Sent to the document owner when all signers have completed signing.
async function sendCompletionEmail(ownerEmail, documentName, signers = []) {
  const subject = `Document fully signed: ${documentName}`;

  const signerList = signers.length > 0
    ? `<ul style="margin:0 0 24px;padding-left:20px;color:#374151;font-size:14px;line-height:2;">${signers.map(s => `<li>${escapeHtml(s)}</li>`).join('')}</ul>`
    : '';

  const html = wrapHtml(subject, `
    <div style="width:48px;height:48px;background:#dcfce7;border-radius:50%;display:flex;align-items:center;justify-content:center;margin:0 0 20px;">
      <span style="font-size:24px;">✓</span>
    </div>
    <h1 style="margin:0 0 16px;color:#111827;font-size:22px;font-weight:700;">
      Document fully signed!
    </h1>
    <p style="margin:0 0 16px;color:#374151;font-size:15px;line-height:1.6;">
      <strong>${escapeHtml(documentName)}</strong> has been signed by all parties.
    </p>
    ${signerList ? `<p style="margin:0 0 8px;color:#374151;font-size:14px;font-weight:600;">Signed by:</p>${signerList}` : ''}
    <p style="margin:0 0 24px;color:#374151;font-size:14px;line-height:1.6;">
      You can now download the completed document from your SecureSign dashboard.
      The document includes a cryptographic signature and full audit trail.
    </p>
    <table cellpadding="0" cellspacing="0">
      <tr>
        <td style="border-radius:6px;background:#2563eb;">
          <a href="${BASE_URL}/dashboard"
             style="display:inline-block;padding:14px 32px;color:#ffffff;
                    font-size:15px;font-weight:600;text-decoration:none;border-radius:6px;">
            View Document →
          </a>
        </td>
      </tr>
    </table>
  `);

  const text = [
    `Document fully signed: ${documentName}`,
    ``,
    `All parties have signed the document.`,
    signers.length > 0 ? `Signed by: ${signers.join(', ')}` : '',
    ``,
    `View your document at: ${BASE_URL}/dashboard`,
  ].filter(Boolean).join('\n');

  const { data, error } = await resend.emails.send({
    from: FROM_ADDRESS, to: ownerEmail, subject, html, text,
  });

  if (error) throw new Error(`Completion email failed: ${error.message}`);
  console.log(`[emailService] Completion email sent → ${ownerEmail} (id: ${data.id})`);
  return { id: data.id };
}

// ── Build signing URL ─────────────────────────────────────────────────────────
function buildSigningUrl(documentId, rawToken) {
  // Token is placed in the URL fragment (#) — NOT the query string (?).
  // Fragments are never sent to the server, never appear in server/CDN/proxy
  // access logs, and are stripped from Referer headers by all major browsers.
  // The token is read client-side by SignDocument.jsx from window.location.hash.
  return `${BASE_URL}/sign/${documentId}#token=${encodeURIComponent(rawToken)}`;
}

module.exports = {
  sendSigningEmail,
  sendVerificationEmail,
  sendPasswordResetEmail,
  sendCompletionEmail,
  buildSigningUrl,
};