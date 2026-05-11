// /frontend/app/sign/[token]/page.jsx
//
// NEW PAGE — public signing portal. No login needed.
// Accessible at: /sign/<token>
//
// Flow:
//   1. Fetch GET /api/sign/:token  → validate + get doc
//   2. If requiresOtp → show OTP screen
//   3. Show PDF viewer with field overlays
//   4. Recipient draws/types signature
//   5. POST /api/sign/:token/submit → done screen
//
// Dependencies (all standard Next.js/React + existing packages):
//   react-pdf:       npm install react-pdf   (PDF rendering)
//   react-signature-canvas: npm install react-signature-canvas

'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { useParams } from 'next/navigation';
import dynamic from 'next/dynamic';

// react-pdf must be dynamically imported (browser-only)
const Document = dynamic(() => import('react-pdf').then(m => m.Document), { ssr: false });
const Page     = dynamic(() => import('react-pdf').then(m => m.Page),     { ssr: false });

// Signature canvas also browser-only
const SignatureCanvas = dynamic(() => import('react-signature-canvas'), { ssr: false });

// ─── States ───────────────────────────────────────────────────
const STEP = {
  LOADING:   'loading',
  OTP:       'otp',
  REVIEWING: 'reviewing',
  SIGNING:   'signing',
  SUBMITTING:'submitting',
  DONE:      'done',
  DECLINED:  'declined',
  ERROR:     'error',
};

export default function SignPage() {
  const { token } = useParams();
  const sigPadRef = useRef(null);

  const [step,        setStep]        = useState(STEP.LOADING);
  const [error,       setError]       = useState('');
  const [data,        setData]        = useState(null);    // { recipient, document }
  const [numPages,    setNumPages]     = useState(null);
  const [otpCode,     setOtpCode]     = useState('');
  const [otpLoading,  setOtpLoading]  = useState(false);
  const [otpError,    setOtpError]    = useState('');
  const [signMethod,  setSignMethod]  = useState('draw');  // 'draw' | 'type'
  const [typedSig,    setTypedSig]    = useState('');
  const [agreedTerms, setAgreedTerms] = useState(false);
  const [declineMode, setDeclineMode] = useState(false);
  const [declineReason, setDeclineReason] = useState('');

  // ─── Initial load ───────────────────────────────────────────
  useEffect(() => {
    if (!token) return;
    fetchDocument();
  }, [token]);

  const fetchDocument = async () => {
    setStep(STEP.LOADING);
    try {
      const res = await fetch(`/api/sign/${token}`);
      const json = await res.json();

      if (!res.ok) {
        setError(json.error || 'This signing link is invalid or has expired.');
        setStep(STEP.ERROR);
        return;
      }

      if (json.requiresOtp) {
        setData({ otp: json });
        setStep(STEP.OTP);
        // Auto-send OTP on load
        await sendOtp();
        return;
      }

      setData(json);
      setStep(STEP.REVIEWING);
    } catch {
      setError('Failed to load document. Please check your connection.');
      setStep(STEP.ERROR);
    }
  };

  // ─── OTP flow ───────────────────────────────────────────────
  const sendOtp = async () => {
    setOtpLoading(true);
    setOtpError('');
    try {
      await fetch(`/api/sign/${token}/otp/send`, { method: 'POST' });
    } catch {
      setOtpError('Failed to send code. Please try again.');
    } finally {
      setOtpLoading(false);
    }
  };

  const verifyOtp = async () => {
    if (otpCode.length !== 6) return;
    setOtpLoading(true);
    setOtpError('');
    try {
      const res = await fetch(`/api/sign/${token}/otp/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ otp: otpCode }),
      });
      const json = await res.json();
      if (json.verified) {
        // Re-fetch document now that OTP is verified
        await fetchDocument();
      } else {
        setOtpError(json.error || 'Invalid code');
      }
    } catch {
      setOtpError('Verification failed. Please try again.');
    } finally {
      setOtpLoading(false);
    }
  };

  // ─── Submit signing ─────────────────────────────────────────
  const submitSign = async () => {
    if (!agreedTerms) return;

    let signatureData = null;
    if (data?.recipient?.role !== 'approver') {
      if (signMethod === 'draw') {
        if (!sigPadRef.current || sigPadRef.current.isEmpty()) {
          return;
        }
        signatureData = sigPadRef.current.getTrimmedCanvas().toDataURL('image/png');
      } else {
        if (!typedSig.trim()) return;
        signatureData = typedSig; // font name or base64 of rendered text
      }
    }

    setStep(STEP.SUBMITTING);
    try {
      const res = await fetch(`/api/sign/${token}/submit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ signatureData, signMethod }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Submission failed');
      setStep(STEP.DONE);
    } catch (err) {
      setError(err.message);
      setStep(STEP.ERROR);
    }
  };

  // ─── Decline ────────────────────────────────────────────────
  const submitDecline = async () => {
    setStep(STEP.SUBMITTING);
    try {
      await fetch(`/api/sign/${token}/decline`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: declineReason }),
      });
      setStep(STEP.DECLINED);
    } catch {
      setStep(STEP.DECLINED); // decline is best-effort
    }
  };

  // ─── Render ─────────────────────────────────────────────────
  return (
    <div style={{ minHeight: '100vh', background: '#F8FAFC', fontFamily: 'system-ui, sans-serif' }}>
      {/* Header */}
      <header style={{
        background: '#0F172A', color: '#fff',
        padding: '14px 20px', display: 'flex', alignItems: 'center', gap: 12,
      }}>
        <div style={{
          width: 32, height: 32, borderRadius: 7,
          background: '#0D9488', display: 'flex', alignItems: 'center',
          justifyContent: 'center', fontWeight: 700, fontSize: 14,
        }}>SS</div>
        <span style={{ fontSize: 15, fontWeight: 600 }}>Secure Sign</span>
        {data?.document && (
          <span style={{ marginLeft: 'auto', fontSize: 12, color: '#94A3B8', maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {data.document.title}
          </span>
        )}
      </header>

      <main style={{ maxWidth: 760, margin: '0 auto', padding: '24px 16px' }}>

        {/* ── LOADING ── */}
        {step === STEP.LOADING && (
          <div style={{ textAlign: 'center', padding: '80px 20px', color: '#64748B' }}>
            <div style={{ fontSize: 32, marginBottom: 16 }}>⏳</div>
            <p>Loading your document...</p>
          </div>
        )}

        {/* ── ERROR ── */}
        {step === STEP.ERROR && (
          <div style={{ background: '#FEE2E2', border: '1px solid #FCA5A5', borderRadius: 12, padding: 32, textAlign: 'center' }}>
            <div style={{ fontSize: 32, marginBottom: 12 }}>⚠️</div>
            <h2 style={{ color: '#991B1B', fontSize: 18, marginBottom: 8 }}>Unable to Open Document</h2>
            <p style={{ color: '#7F1D1D', fontSize: 14 }}>{error}</p>
          </div>
        )}

        {/* ── OTP ── */}
        {step === STEP.OTP && (
          <div style={{ background: '#fff', borderRadius: 12, border: '1px solid #E2E8F0', padding: 32, maxWidth: 400, margin: '40px auto' }}>
            <h2 style={{ fontSize: 18, fontWeight: 700, marginBottom: 8, color: '#0F172A' }}>Verify Your Identity</h2>
            <p style={{ fontSize: 13, color: '#64748B', marginBottom: 24 }}>
              A verification code has been sent to {data?.otp?.maskedDestination || 'you'}.
            </p>
            <input
              type="text"
              inputMode="numeric"
              pattern="[0-9]*"
              placeholder="Enter 6-digit code"
              maxLength={6}
              value={otpCode}
              onChange={e => setOtpCode(e.target.value.replace(/\D/g, ''))}
              onKeyDown={e => e.key === 'Enter' && verifyOtp()}
              style={{
                width: '100%', padding: '12px 16px', fontSize: 20, textAlign: 'center',
                letterSpacing: 8, border: '1.5px solid #E2E8F0', borderRadius: 8,
                outline: 'none', marginBottom: 12, boxSizing: 'border-box',
              }}
            />
            {otpError && <p style={{ color: '#DC2626', fontSize: 12, marginBottom: 12 }}>{otpError}</p>}
            <button
              onClick={verifyOtp}
              disabled={otpCode.length !== 6 || otpLoading}
              style={{
                width: '100%', background: otpCode.length === 6 ? '#0D9488' : '#E2E8F0',
                color: otpCode.length === 6 ? '#fff' : '#94A3B8',
                border: 'none', borderRadius: 8, padding: '12px 0',
                fontSize: 14, fontWeight: 600, cursor: 'pointer', marginBottom: 12,
              }}
            >
              {otpLoading ? 'Verifying...' : 'Verify Code'}
            </button>
            <button onClick={sendOtp} disabled={otpLoading}
              style={{ background: 'none', border: 'none', color: '#0D9488', fontSize: 13, cursor: 'pointer', width: '100%' }}>
              Resend code
            </button>
          </div>
        )}

        {/* ── REVIEWING ── */}
        {step === STEP.REVIEWING && data && (
          <>
            {/* Recipient info bar */}
            <div style={{ background: '#EFF6FF', border: '1px solid #BFDBFE', borderRadius: 8, padding: '10px 16px', marginBottom: 16, display: 'flex', alignItems: 'center', gap: 10, fontSize: 13 }}>
              <span style={{ background: '#2563EB', color: '#fff', borderRadius: 4, padding: '2px 8px', fontWeight: 600, fontSize: 11 }}>
                {data.recipient.role.toUpperCase()}
              </span>
              <span style={{ color: '#1E40AF' }}>{data.recipient.name} — {data.document.orgName}</span>
              {data.document.stepName && (
                <span style={{ marginLeft: 'auto', color: '#64748B', fontSize: 12 }}>Step: {data.document.stepName}</span>
              )}
            </div>

            {/* PDF viewer */}
            <div style={{ background: '#fff', border: '1px solid #E2E8F0', borderRadius: 12, overflow: 'hidden', marginBottom: 16 }}>
              <Document
                file={data.document.pdfUrl}
                onLoadSuccess={({ numPages }) => setNumPages(numPages)}
                loading={<div style={{ padding: 40, textAlign: 'center', color: '#64748B' }}>Loading PDF...</div>}
              >
                {Array.from({ length: numPages || 1 }, (_, i) => (
                  <Page
                    key={i + 1}
                    pageNumber={i + 1}
                    width={Math.min(window.innerWidth - 48, 712)}
                    renderTextLayer={false}
                    renderAnnotationLayer={false}
                  />
                ))}
              </Document>
            </div>

            {/* Decline option */}
            {!declineMode ? (
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
                <span style={{ fontSize: 13, color: '#64748B' }}>
                  {data.recipient.role === 'approver' ? 'Review the document above and approve or decline below.' : 'Scroll through the document, then sign below.'}
                </span>
                <button onClick={() => setDeclineMode(true)}
                  style={{ background: 'none', border: '1px solid #E2E8F0', borderRadius: 6, padding: '6px 14px', fontSize: 12, color: '#64748B', cursor: 'pointer' }}>
                  Decline
                </button>
              </div>
            ) : (
              <div style={{ background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: 10, padding: 16, marginBottom: 16 }}>
                <p style={{ fontSize: 13, fontWeight: 600, color: '#991B1B', marginBottom: 8 }}>Decline to Sign</p>
                <textarea
                  value={declineReason}
                  onChange={e => setDeclineReason(e.target.value)}
                  placeholder="Reason for declining (optional)"
                  rows={3}
                  style={{ width: '100%', padding: '8px 12px', border: '1px solid #FECACA', borderRadius: 6, fontSize: 13, boxSizing: 'border-box', marginBottom: 8, resize: 'vertical' }}
                />
                <div style={{ display: 'flex', gap: 8 }}>
                  <button onClick={submitDecline}
                    style={{ background: '#DC2626', color: '#fff', border: 'none', borderRadius: 6, padding: '8px 16px', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>
                    Confirm Decline
                  </button>
                  <button onClick={() => setDeclineMode(false)}
                    style={{ background: '#fff', border: '1px solid #E2E8F0', borderRadius: 6, padding: '8px 16px', fontSize: 13, cursor: 'pointer' }}>
                    Cancel
                  </button>
                </div>
              </div>
            )}

            {/* Signature section (skip for viewer/approver roles) */}
            {data.recipient.role !== 'viewer' && !declineMode && (
              <div style={{ background: '#fff', border: '1px solid #E2E8F0', borderRadius: 12, padding: 20 }}>
                <h3 style={{ fontSize: 14, fontWeight: 600, marginBottom: 12, color: '#0F172A' }}>
                  {data.recipient.role === 'approver' ? 'Approve Document' : 'Your Signature'}
                </h3>

                {data.recipient.role !== 'approver' && (
                  <>
                    {/* Sign method toggle */}
                    <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
                      {['draw', 'type'].map(m => (
                        <button key={m} onClick={() => setSignMethod(m)}
                          style={{
                            padding: '8px 18px', borderRadius: 6, fontSize: 13, fontWeight: 500, cursor: 'pointer',
                            background: signMethod === m ? '#0D9488' : '#fff',
                            color: signMethod === m ? '#fff' : '#64748B',
                            border: `1.5px solid ${signMethod === m ? '#0D9488' : '#E2E8F0'}`,
                          }}>
                          {m === 'draw' ? '✏️ Draw' : 'T Type'}
                        </button>
                      ))}
                    </div>

                    {signMethod === 'draw' ? (
                      <div style={{ border: '2px dashed #0D9488', borderRadius: 8, background: '#F0FDFA', position: 'relative' }}>
                        <SignatureCanvas
                          ref={sigPadRef}
                          canvasProps={{
                            style: { width: '100%', height: 160, display: 'block' },
                            className: 'signature-canvas',
                          }}
                          penColor="#0F172A"
                        />
                        <button
                          onClick={() => sigPadRef.current?.clear()}
                          style={{
                            position: 'absolute', top: 8, right: 8, background: 'rgba(255,255,255,0.9)',
                            border: '1px solid #E2E8F0', borderRadius: 4, padding: '4px 10px', fontSize: 11, cursor: 'pointer',
                          }}>
                          Clear
                        </button>
                        <p style={{ textAlign: 'center', fontSize: 11, color: '#94A3B8', padding: '4px 0 8px' }}>
                          Sign with your finger or mouse
                        </p>
                      </div>
                    ) : (
                      <div>
                        <input
                          type="text"
                          value={typedSig}
                          onChange={e => setTypedSig(e.target.value)}
                          placeholder="Type your full name"
                          style={{
                            width: '100%', padding: '12px 16px', fontSize: 20,
                            fontFamily: "'Dancing Script', cursive",
                            border: '2px dashed #0D9488', borderRadius: 8, background: '#F0FDFA',
                            outline: 'none', boxSizing: 'border-box', color: '#0F172A',
                          }}
                        />
                        <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Dancing+Script:wght@600&display=swap" />
                      </div>
                    )}
                  </>
                )}

                {/* Terms + Submit */}
                <label style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '16px 0', cursor: 'pointer', fontSize: 13, color: '#475569' }}>
                  <input type="checkbox" checked={agreedTerms} onChange={e => setAgreedTerms(e.target.checked)}
                    style={{ width: 16, height: 16, accentColor: '#0D9488', cursor: 'pointer' }} />
                  I agree that this constitutes my legal electronic signature
                </label>

                <button
                  onClick={submitSign}
                  disabled={!agreedTerms}
                  style={{
                    width: '100%', background: agreedTerms ? '#0D9488' : '#E2E8F0',
                    color: agreedTerms ? '#fff' : '#94A3B8',
                    border: 'none', borderRadius: 8, padding: '14px 0',
                    fontSize: 15, fontWeight: 700, cursor: agreedTerms ? 'pointer' : 'not-allowed',
                  }}>
                  {data.recipient.role === 'approver' ? '✓ Approve Document' : '✍️ Complete Signing'}
                </button>
              </div>
            )}
          </>
        )}

        {/* ── SUBMITTING ── */}
        {step === STEP.SUBMITTING && (
          <div style={{ textAlign: 'center', padding: '80px 20px', color: '#64748B' }}>
            <div style={{ fontSize: 32, marginBottom: 16, animation: 'spin 1s linear infinite' }}>⏳</div>
            <p>Processing your signature...</p>
          </div>
        )}

        {/* ── DONE ── */}
        {step === STEP.DONE && (
          <div style={{ background: '#F0FDF4', border: '1px solid #86EFAC', borderRadius: 12, padding: 48, textAlign: 'center' }}>
            <div style={{ fontSize: 48, marginBottom: 16 }}>✅</div>
            <h2 style={{ fontSize: 22, fontWeight: 700, color: '#065F46', marginBottom: 8 }}>Signed Successfully</h2>
            <p style={{ color: '#047857', fontSize: 14 }}>
              A confirmation email has been sent to you. You will receive the completed document
              once all parties have signed.
            </p>
          </div>
        )}

        {/* ── DECLINED ── */}
        {step === STEP.DECLINED && (
          <div style={{ background: '#FEF2F2', border: '1px solid #FCA5A5', borderRadius: 12, padding: 48, textAlign: 'center' }}>
            <div style={{ fontSize: 48, marginBottom: 16 }}>📋</div>
            <h2 style={{ fontSize: 22, fontWeight: 700, color: '#991B1B', marginBottom: 8 }}>Decline Recorded</h2>
            <p style={{ color: '#7F1D1D', fontSize: 14 }}>
              The sender has been notified. This signing link is now deactivated.
            </p>
          </div>
        )}

      </main>

      {/* Footer */}
      <footer style={{ textAlign: 'center', padding: '20px', fontSize: 11, color: '#94A3B8', borderTop: '1px solid #E2E8F0', marginTop: 40 }}>
        Secured by Secure Sign · Your data is encrypted and protected
      </footer>
    </div>
  );
}
