'use strict';

/**
 * emailService.js — HakikiSign Email Delivery (v2)
 *
 * CHANGES FROM v1
 * ─────────────────
 * + sendOtpEmail    — delivers OTP codes via email (fallback for WhatsApp OTP)
 * + Fixed all functions to properly return { id } from Brevo response
 * + sendSigningEmail now accepts optional senderName parameter
 *
 * ALL EXISTING FUNCTION SIGNATURES ARE UNCHANGED.
 * This is a DROP-IN REPLACEMENT.
 */

const https = require('https');

async function sendViaBrevo(to, from, subject, html, text) {
  const payload = JSON.stringify({
    sender:      { email: from.match(/<(.+)>/)?.[1] || from, name: from.match(/^(.+?)\s*</)?.[1]?.trim() || 'HakikiSign' },
    to:          [{ email: to }],
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
        'api-key':       process.env.BREVO_API_KEY,
        'Content-Type':  'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(data)); } catch { resolve({ raw: data }); }
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

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

function wrapHtml(title, bodyHtml) {
  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
</head>
<body style="margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,sans-serif;background:#f3f4f6;">
  <table width="100%" cellpadding="0" cellspacing="0" style="padding:32px 16px;">
    <tr>
      <td align="center">
        <table width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08);max-width:600px;">
          <tr><td style="background:linear-gradient(135deg,#1a56b0 0%,#1e40af 100%);padding:0;height:5px;"></td></tr>
          <tr>
            <td style="padding:32px 48px 24px;border-bottom:1px solid #f1f5f9;">
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td>
                    <p style="margin:0;font-size:22px;font-weight:800;color:#0f172a;letter-spacing:-0.5px;">✍️ HakikiSign</p>
                    <p style="margin:4px 0 0;font-size:12px;color:#64748b;letter-spacing:0.5px;text-transform:uppercase;">Secure Electronic Signatures</p>
                  </td>
                  <td align="right">
                    <span style="display:inline-block;padding:4px 12px;background:#eff6ff;color:#1d4ed8;font-size:11px;font-weight:600;border-radius:20px;border:1px solid #bfdbfe;">Action Required</span>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr><td style="padding:40px 48px 32px;">${bodyHtml}</td></tr>
          <tr>
            <td style="padding:20px 48px;background:#f8fafc;border-top:1px solid #e2e8f0;">
              <table cellpadding="0" cellspacing="0">
                <tr>
                  <td style="padding-right:10px;vertical-align:top;"><span style="font-size:18px;">🔒</span></td>
                  <td>
                    <p style="margin:0;color:#475569;font-size:12px;line-height:1.6;">
                      <strong style="color:#0f172a;">Secured by HakikiSign.</strong>
                      This signing link is unique to you and encrypted end-to-end. Do not forward or share this email.
                    </p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td style="padding:20px 48px 28px;background:#f8fafc;">
              <p style="margin:0;color:#94a3b8;font-size:11px;line-height:1.6;text-align:center;">
                You received this because someone requested your signature via HakikiSign.<br>
                If you were not expecting this, you can safely ignore this email.
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

// ── Build signing URL ─────────────────────────────────────────────────────────
function buildSigningUrl(documentId, rawToken) {
  return `${BASE_URL}/sign/${documentId}#token=${encodeURIComponent(rawToken)}`;
}

// ── Send signing request email ────────────────────────────────────────────────
async function sendSigningEmail(recipientEmail, signingLink, documentName = 'a document', senderName = null) {
  const subject = 'Document Signing Request';
  const fromLabel = senderName ? `${escapeHtml(senderName)} via HakikiSign` : 'HakikiSign';

  const html = wrapHtml(subject, `
    <p style="margin:0 0 8px;color:#64748b;font-size:13px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;">Signature Requested</p>
    <h1 style="margin:0 0 20px;color:#0f172a;font-size:26px;font-weight:800;line-height:1.2;">You have a document<br>ready to sign</h1>
    <div style="background:#f0f7ff;border-left:4px solid #1a56b0;border-radius:0 8px 8px 0;padding:16px 20px;margin:0 0 28px;">
      <p style="margin:0;color:#1e40af;font-size:13px;font-weight:600;text-transform:uppercase;letter-spacing:0.3px;">Document</p>
      <p style="margin:4px 0 0;color:#0f172a;font-size:16px;font-weight:700;">${escapeHtml(documentName)}</p>
      ${senderName ? `<p style="margin:4px 0 0;color:#64748b;font-size:13px;">Requested by: <strong>${escapeHtml(senderName)}</strong></p>` : ''}
    </div>
    <p style="margin:0 0 32px;color:#475569;font-size:15px;line-height:1.7;">
      ${fromLabel} has requested your electronic signature. Click below to review and sign.
      This link expires in <strong style="color:#0f172a;">${process.env.RECIPIENT_TOKEN_EXPIRY_HOURS || 72} hours</strong>.
    </p>
    <table cellpadding="0" cellspacing="0" style="margin:0 0 32px;">
      <tr>
        <td style="border-radius:10px;background:#1a56b0;box-shadow:0 4px 16px rgba(26,86,176,0.35);">
          <a href="${signingLink}" style="display:inline-block;padding:18px 48px;color:#ffffff;font-size:16px;font-weight:700;text-decoration:none;border-radius:10px;letter-spacing:-0.2px;">
            Review &amp; Sign Document →
          </a>
        </td>
      </tr>
    </table>
    <div style="background:#fafafa;border:1px solid #e2e8f0;border-radius:8px;padding:16px 20px;">
      <p style="margin:0 0 6px;color:#64748b;font-size:12px;font-weight:600;">Having trouble with the button?</p>
      <p style="margin:0;color:#94a3b8;font-size:12px;line-height:1.6;">
        Copy and paste this link:<br>
        <a href="${signingLink}" style="color:#2563eb;word-break:break-all;font-size:11px;">${signingLink}</a>
      </p>
    </div>
  `);

  const text = [
    `Document Signing Request`,
    ``,
    `You have been asked to sign: ${documentName}`,
    senderName ? `Requested by: ${senderName}` : '',
    ``,
    `Sign here: ${signingLink}`,
    ``,
    `This link expires in ${process.env.RECIPIENT_TOKEN_EXPIRY_HOURS || 72} hours.`,
  ].filter(l => l !== undefined).join('\n');

  const result = await sendViaBrevo(recipientEmail, FROM_ADDRESS, subject, html, text);
  return { id: result?.messageId || result?.id };
}

// ── Send OTP via email (fallback for WhatsApp OTP) ────────────────────────────
async function sendOtpEmail(recipientEmail, otpCode, documentName = 'a document', expiryMinutes = 10) {
  const subject = 'Your HakikiSign verification code';

  const html = wrapHtml(subject, `
    <p style="margin:0 0 8px;color:#64748b;font-size:13px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;">Identity Verification</p>
    <h1 style="margin:0 0 16px;color:#0f172a;font-size:24px;font-weight:800;">Your signing verification code</h1>
    <p style="margin:0 0 20px;color:#475569;font-size:15px;line-height:1.7;">
      Use this code to verify your identity before signing <strong>${escapeHtml(documentName)}</strong>.
    </p>
    <div style="text-align:center;padding:32px;background:#f0f7ff;border-radius:12px;margin:0 0 28px;">
      <p style="margin:0 0 8px;color:#64748b;font-size:13px;font-weight:600;text-transform:uppercase;">Your Code</p>
      <p style="margin:0;color:#1a56b0;font-size:48px;font-weight:900;letter-spacing:12px;font-variant-numeric:tabular-nums;">${escapeHtml(otpCode)}</p>
      <p style="margin:8px 0 0;color:#94a3b8;font-size:12px;">Valid for ${expiryMinutes} minutes</p>
    </div>
    <p style="margin:0;color:#ef4444;font-size:13px;font-weight:600;">
      🚨 Never share this code. HakikiSign will never ask for it by phone or email.
    </p>
  `);

  const text = [
    `Your HakikiSign verification code`,
    ``,
    `Document: ${documentName}`,
    ``,
    `Your code: ${otpCode}`,
    ``,
    `Valid for ${expiryMinutes} minutes.`,
    `Never share this code with anyone.`,
  ].join('\n');

  const result = await sendViaBrevo(recipientEmail, FROM_ADDRESS, subject, html, text);
  return { id: result?.messageId || result?.id };
}

// ── Send email verification ───────────────────────────────────────────────────
async function sendVerificationEmail(recipientEmail, verifyLink) {
  const subject = 'Activate your HakikiSign account';

  const html = wrapHtml(subject, `
    <p style="margin:0 0 8px;color:#6b7280;font-size:13px;font-weight:600;letter-spacing:0.05em;text-transform:uppercase;">Welcome to HakikiSign</p>
    <h1 style="margin:0 0 16px;color:#111827;font-size:24px;font-weight:800;letter-spacing:-0.3px;">Activate your account</h1>
    <p style="margin:0 0 8px;color:#374151;font-size:15px;line-height:1.6;">Thanks for signing up! To get started, activate your account by clicking below.</p>
    <p style="margin:0 0 32px;color:#6b7280;font-size:14px;line-height:1.6;">This activation link expires in <strong style="color:#374151;">24 hours</strong>.</p>
    <table cellpadding="0" cellspacing="0" style="margin-bottom:32px;">
      <tr>
        <td style="border-radius:6px;background:#1a56b0;">
          <a href="${verifyLink}" style="display:inline-block;padding:16px 40px;color:#ffffff;font-size:16px;font-weight:700;text-decoration:none;border-radius:6px;">Activate Account</a>
        </td>
      </tr>
    </table>
    <div style="border-top:1px solid #e5e7eb;padding-top:20px;">
      <p style="margin:0 0 6px;color:#9ca3af;font-size:12px;">Button not working? Copy and paste:</p>
      <a href="${verifyLink}" style="color:#2563eb;font-size:12px;word-break:break-all;line-height:1.5;">${verifyLink}</a>
    </div>
  `);

  const text = [
    `Activate your HakikiSign account`,
    ``,
    `Visit: ${verifyLink}`,
    ``,
    `Expires in 24 hours.`,
  ].join('\n');

  const result = await sendViaBrevo(recipientEmail, FROM_ADDRESS, subject, html, text);
  return { id: result?.messageId || result?.id };
}

// ── Send password reset ───────────────────────────────────────────────────────
async function sendPasswordResetEmail(recipientEmail, resetLink) {
  const subject = 'Reset your HakikiSign password';

  const html = wrapHtml(subject, `
    <h1 style="margin:0 0 16px;color:#111827;font-size:22px;font-weight:700;">Reset your password</h1>
    <p style="margin:0 0 24px;color:#374151;font-size:15px;line-height:1.6;">
      We received a request to reset your HakikiSign password. This link expires in <strong>1 hour</strong>.
    </p>
    <table cellpadding="0" cellspacing="0" style="margin-bottom:32px;">
      <tr>
        <td style="border-radius:6px;background:#dc2626;">
          <a href="${resetLink}" style="display:inline-block;padding:14px 32px;color:#ffffff;font-size:15px;font-weight:600;text-decoration:none;border-radius:6px;">Reset Password →</a>
        </td>
      </tr>
    </table>
    <p style="margin:0 0 16px;color:#6b7280;font-size:13px;line-height:1.5;">
      Or copy: <a href="${resetLink}" style="color:#2563eb;word-break:break-all;">${resetLink}</a>
    </p>
    <p style="margin:0;color:#6b7280;font-size:13px;">If you didn't request this, you can safely ignore this email.</p>
  `);

  const text = [
    `Reset your HakikiSign password`,
    ``,
    `Visit: ${resetLink}`,
    ``,
    `Expires in 1 hour.`,
  ].join('\n');

  const result = await sendViaBrevo(recipientEmail, FROM_ADDRESS, subject, html, text);
  return { id: result?.messageId || result?.id };
}

// ── Send completion notification ──────────────────────────────────────────────
async function sendCompletionEmail(ownerEmail, documentName, signers = []) {
  const subject = `Document fully signed: ${documentName}`;

  const signerList = signers.length > 0
    ? `<ul style="margin:0 0 24px;padding-left:20px;color:#374151;font-size:14px;line-height:2;">${signers.map(s => `<li>${escapeHtml(s)}</li>`).join('')}</ul>`
    : '';

  const html = wrapHtml(subject, `
    <div style="width:48px;height:48px;background:#dcfce7;border-radius:50%;display:flex;align-items:center;justify-content:center;margin:0 0 20px;">
      <span style="font-size:24px;">✓</span>
    </div>
    <h1 style="margin:0 0 16px;color:#111827;font-size:22px;font-weight:700;">Document fully signed!</h1>
    <p style="margin:0 0 16px;color:#374151;font-size:15px;line-height:1.6;"><strong>${escapeHtml(documentName)}</strong> has been signed by all parties.</p>
    ${signerList ? `<p style="margin:0 0 8px;color:#374151;font-size:14px;font-weight:600;">Signed by:</p>${signerList}` : ''}
    <p style="margin:0 0 24px;color:#374151;font-size:14px;line-height:1.6;">
      Download the completed document from your HakikiSign dashboard.
    </p>
    <table cellpadding="0" cellspacing="0">
      <tr>
        <td style="border-radius:6px;background:#1a56b0;">
          <a href="${BASE_URL}/dashboard" style="display:inline-block;padding:14px 32px;color:#ffffff;font-size:15px;font-weight:600;text-decoration:none;border-radius:6px;">View Document →</a>
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
    `View at: ${BASE_URL}/dashboard`,
  ].filter(Boolean).join('\n');

  const result = await sendViaBrevo(ownerEmail, FROM_ADDRESS, subject, html, text);
  return { id: result?.messageId || result?.id };
}

// ── Send decline notification ─────────────────────────────────────────────────
async function sendDeclineEmail(ownerEmail, documentName, signerEmail, reason) {
  const subject = `Signing declined: ${documentName}`;

  const html = wrapHtml(subject, `
    <div style="width:48px;height:48px;background:#fee2e2;border-radius:50%;display:flex;align-items:center;justify-content:center;margin:0 0 20px;">
      <span style="font-size:24px;line-height:1;">✕</span>
    </div>
    <h1 style="margin:0 0 8px;color:#111827;font-size:22px;font-weight:700;letter-spacing:-0.3px;">A signer has declined</h1>
    <p style="margin:0 0 24px;color:#6b7280;font-size:14px;">
      The signing workflow for <strong style="color:#111827;">${escapeHtml(documentName)}</strong> has been stopped.
    </p>
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;margin-bottom:24px;">
      <tr>
        <td style="padding:16px 20px;">
          <table width="100%" cellpadding="0" cellspacing="4">
            <tr>
              <td style="width:110px;color:#9ca3af;font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;padding:4px 0;">Declined by</td>
              <td style="color:#111827;font-size:14px;padding:4px 0;">${escapeHtml(signerEmail)}</td>
            </tr>
            <tr>
              <td style="color:#9ca3af;font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;padding:4px 0;vertical-align:top;">Reason</td>
              <td style="color:#374151;font-size:14px;padding:4px 0;line-height:1.5;">${escapeHtml(reason)}</td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
    <p style="margin:0 0 28px;color:#374151;font-size:14px;line-height:1.6;">This event has been recorded in the document audit trail.</p>
    <table cellpadding="0" cellspacing="0">
      <tr>
        <td style="border-radius:6px;background:#1a56b0;">
          <a href="${BASE_URL}/manage" style="display:inline-block;padding:14px 28px;color:#ffffff;font-size:15px;font-weight:600;text-decoration:none;border-radius:6px;">View Document →</a>
        </td>
      </tr>
    </table>
  `);

  const text = [
    `Signing declined: ${documentName}`,
    ``,
    `Declined by: ${signerEmail}`,
    `Reason: ${reason}`,
    ``,
    `View at: ${BASE_URL}/manage`,
  ].join('\n');

  const result = await sendViaBrevo(ownerEmail, FROM_ADDRESS, subject, html, text);
  return { id: result?.messageId || result?.id };
}

module.exports = {
  sendDeclineEmail,
  sendSigningEmail,
  sendVerificationEmail,
  sendPasswordResetEmail,
  sendCompletionEmail,
  sendOtpEmail,
  buildSigningUrl,
};
