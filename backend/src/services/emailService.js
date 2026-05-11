'use strict';

const https = require('https');

async function sendViaBrevo(to, from, subject, html, text) {
  const payload = JSON.stringify({
    sender:   { email: from.match(/<(.+)>/)?.[1] || from, name: from.match(/^(.+?)\s*</)?.[1]?.trim() || 'HakikiSign' },
    to:       [{ email: to }],
    subject,
    htmlContent: html,
    textContent: text,
  });

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.brevo.com',
      path:     '/v3/smtp/email',
      method:   'POST',
      headers: {
        'api-key':      process.env.BREVO_API_KEY,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(JSON.parse(data));
        } else {
          reject(new Error(`Brevo API error ${res.statusCode}: ${data}`));
        }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

const FROM_ADDRESS = process.env.EMAIL_FROM || 'HakikiSign <noreply@hakikisign.app>';
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
                         letter-spacing:-0.3px;">✍️ HakikiSign</p>
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
                This email was sent by HakikiSign. If you were not expecting it, you can safely ignore it.
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
        <td style="border-radius:6px;background:#1a56b0;">
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

  await sendViaBrevo(recipientEmail, FROM_ADDRESS, subject, html, text);
  console.log(`[emailService] Signing email sent -> ${recipientEmail}`);
  return { id: data.id };
}

// -- Send email verification / account activation email --
async function sendVerificationEmail(recipientEmail, verifyLink) {
  const subject = 'Activate your HakikiSign account';

  const html = wrapHtml(subject, `
    <p style="margin:0 0 8px;color:#6b7280;font-size:13px;font-weight:600;letter-spacing:0.05em;text-transform:uppercase;">
      Welcome to HakikiSign
    </p>
    <h1 style="margin:0 0 16px;color:#111827;font-size:24px;font-weight:800;letter-spacing:-0.3px;">
      Activate your account
    </h1>
    <p style="margin:0 0 8px;color:#374151;font-size:15px;line-height:1.6;">
      Thanks for signing up! To get started, please activate your account by clicking the button below.
    </p>
    <p style="margin:0 0 32px;color:#6b7280;font-size:14px;line-height:1.6;">
      This activation link expires in <strong style="color:#374151;">24 hours</strong>.
      If you did not create a HakikiSign account, you can safely ignore this email.
    </p>
    <table cellpadding="0" cellspacing="0" style="margin-bottom:32px;">
      <tr>
        <td style="border-radius:6px;background:#1a56b0;">
          <a href="${verifyLink}"
             style="display:inline-block;padding:16px 40px;color:#ffffff;
                    font-size:16px;font-weight:700;text-decoration:none;
                    border-radius:6px;letter-spacing:-0.1px;">
            Activate Account
          </a>
        </td>
      </tr>
    </table>
    <div style="border-top:1px solid #e5e7eb;padding-top:20px;">
      <p style="margin:0 0 6px;color:#9ca3af;font-size:12px;">
        Button not working? Copy and paste this link into your browser:
      </p>
      <a href="${verifyLink}" style="color:#2563eb;font-size:12px;word-break:break-all;line-height:1.5;">${verifyLink}</a>
    </div>
  `);

  const text = [
    `Activate your HakikiSign account`,
    ``,
    `Thanks for signing up! Please activate your account by visiting:`,
    verifyLink,
    ``,
    `This link expires in 24 hours.`,
    `If you did not create a HakikiSign account, you can safely ignore this email.`,
  ].join('\n');

  await sendViaBrevo(recipientEmail, FROM_ADDRESS, subject, html, text);
  console.log(`[emailService] Activation email sent -> ${recipientEmail}`);
  return { id: data.id };
}

// ── Send password reset email ─────────────────────────────────────────────────
async function sendPasswordResetEmail(recipientEmail, resetLink) {
  const subject = 'Reset your HakikiSign password';

  const html = wrapHtml(subject, `
    <h1 style="margin:0 0 16px;color:#111827;font-size:22px;font-weight:700;">
      Reset your password
    </h1>
    <p style="margin:0 0 24px;color:#374151;font-size:15px;line-height:1.6;">
      We received a request to reset your HakikiSign password.
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
    `Reset your HakikiSign password`,
    ``,
    `We received a request to reset your password. Visit the link below:`,
    resetLink,
    ``,
    `This link expires in 1 hour.`,
    `If you didn't request this, you can safely ignore this email.`,
  ].join('\n');

  await sendViaBrevo(recipientEmail, FROM_ADDRESS, subject, html, text);
  console.log(`[emailService] Password reset email sent -> ${recipientEmail}`);
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
      You can now download the completed document from your HakikiSign dashboard.
      The document includes a cryptographic signature and full audit trail.
    </p>
    <table cellpadding="0" cellspacing="0">
      <tr>
        <td style="border-radius:6px;background:#1a56b0;">
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

  await sendViaBrevo(ownerEmail, FROM_ADDRESS, subject, html, text);
  console.log(`[emailService] Completion email sent -> ${ownerEmail}`);
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

// ── Send decline notification to document owner ───────────────────────────────
async function sendDeclineEmail(ownerEmail, documentName, signerEmail, reason) {
  const subject = `Signing declined: ${documentName}`;

  const html = wrapHtml(subject, `
    <div style="width:48px;height:48px;background:#fee2e2;border-radius:50%;
                display:flex;align-items:center;justify-content:center;margin:0 0 20px;">
      <span style="font-size:24px;line-height:1;">✕</span>
    </div>
    <h1 style="margin:0 0 8px;color:#111827;font-size:22px;font-weight:700;letter-spacing:-0.3px;">
      A signer has declined
    </h1>
    <p style="margin:0 0 24px;color:#6b7280;font-size:14px;">
      The signing workflow for <strong style="color:#111827;">${escapeHtml(documentName)}</strong>
      has been stopped.
    </p>

    <table width="100%" cellpadding="0" cellspacing="0"
           style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;margin-bottom:24px;">
      <tr>
        <td style="padding:16px 20px;">
          <table width="100%" cellpadding="0" cellspacing="4">
            <tr>
              <td style="width:110px;color:#9ca3af;font-size:12px;font-weight:600;
                          text-transform:uppercase;letter-spacing:0.05em;padding:4px 0;">
                Declined by
              </td>
              <td style="color:#111827;font-size:14px;padding:4px 0;">
                ${escapeHtml(signerEmail)}
              </td>
            </tr>
            <tr>
              <td style="color:#9ca3af;font-size:12px;font-weight:600;
                          text-transform:uppercase;letter-spacing:0.05em;padding:4px 0;
                          vertical-align:top;">
                Reason
              </td>
              <td style="color:#374151;font-size:14px;padding:4px 0;line-height:1.5;">
                ${escapeHtml(reason)}
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>

    <p style="margin:0 0 8px;color:#374151;font-size:14px;line-height:1.6;">
      All pending signers downstream of the declining signer have been notified that
      the workflow has stopped. No further signatures will be collected unless you
      void the document and start a new signing request.
    </p>
    <p style="margin:0 0 28px;color:#6b7280;font-size:13px;line-height:1.5;">
      This event has been recorded in the document audit trail.
    </p>

    <table cellpadding="0" cellspacing="0">
      <tr>
        <td style="border-radius:6px;background:#1a56b0;">
          <a href="${BASE_URL}/manage"
             style="display:inline-block;padding:14px 28px;color:#ffffff;
                    font-size:15px;font-weight:600;text-decoration:none;border-radius:6px;">
            View Document →
          </a>
        </td>
      </tr>
    </table>
  `);

  const text = [
    `Signing declined: ${documentName}`,
    ``,
    `A signer has declined to sign this document.`,
    ``,
    `Declined by: ${signerEmail}`,
    `Reason: ${reason}`,
    ``,
    `The signing workflow has been stopped. All pending signers have been cancelled.`,
    `This event has been recorded in the document audit trail.`,
    ``,
    `View your documents at: ${BASE_URL}/manage`,
  ].join('\n');

  await sendViaBrevo(ownerEmail, FROM_ADDRESS, subject, html, text);
  console.log(`[emailService] Decline notification sent -> ${ownerEmail}`);
}


module.exports = {
  sendDeclineEmail,
  sendSigningEmail,
  sendVerificationEmail,
  sendPasswordResetEmail,
  sendCompletionEmail,
  buildSigningUrl,
};