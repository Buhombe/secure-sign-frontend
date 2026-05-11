/**
 * DeclineModal.jsx
 *
 * Enterprise-grade decline-to-sign modal for HakikiSign.
 *
 * Features:
 *  - Mandatory reason (10–1000 chars)
 *  - Predefined reason quick-select chips
 *  - Custom text area
 *  - Two-step confirmation (consequences screen → reason screen → confirm)
 *  - Loading state during API call
 *  - Error display
 *  - Mobile responsive
 *  - Accessible (focus trap, ARIA labels)
 */

import { useState, useEffect, useRef, useCallback } from 'react';

const PREDEFINED_REASONS = [
  'I did not initiate or authorize this request',
  'The document content is inaccurate or incorrect',
  'I need legal counsel before signing',
  'The terms require amendment before I can agree',
  'I am not the correct signatory for this document',
  'I require more time to review the document',
];

const REASON_MIN = 10;
const REASON_MAX = 1000;

// Steps: 'warning' → 'reason' → 'confirm' → 'loading' → 'done'
const STEP = {
  WARNING:  'warning',
  REASON:   'reason',
  CONFIRM:  'confirm',
  LOADING:  'loading',
};

export default function DeclineModal({
  documentName,
  onDecline,       // async (reason: string) => void — called with sanitised reason
  onCancel,
  disabled = false,
}) {
  const [step,           setStep]           = useState(STEP.WARNING);
  const [reason,         setReason]         = useState('');
  const [selectedPreset, setSelectedPreset] = useState(null);
  const [error,          setError]          = useState('');
  const [apiError,       setApiError]       = useState('');

  const textAreaRef = useRef(null);
  const modalRef    = useRef(null);
  const firstBtnRef = useRef(null);

  // Focus first interactive element on step change
  useEffect(() => {
    const timer = setTimeout(() => {
      if (firstBtnRef.current) firstBtnRef.current.focus();
    }, 80);
    return () => clearTimeout(timer);
  }, [step]);

  // Focus trap inside modal
  const handleKeyDown = useCallback((e) => {
    if (e.key === 'Escape') { onCancel(); return; }
    if (e.key !== 'Tab') return;
    const modal = modalRef.current;
    if (!modal) return;
    const focusable = modal.querySelectorAll(
      'button:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    );
    const first = focusable[0];
    const last  = focusable[focusable.length - 1];
    if (e.shiftKey ? document.activeElement === first : document.activeElement === last) {
      e.preventDefault();
      (e.shiftKey ? last : first).focus();
    }
  }, [onCancel]);

  const selectPreset = (preset) => {
    setSelectedPreset(preset);
    setReason(preset);
    setError('');
    if (textAreaRef.current) textAreaRef.current.focus();
  };

  const handleTextChange = (e) => {
    setReason(e.target.value.slice(0, REASON_MAX));
    setSelectedPreset(null);
    setError('');
  };

  const validateReason = () => {
    const trimmed = reason.trim();
    if (trimmed.length < REASON_MIN) {
      setError(`Please provide a reason of at least ${REASON_MIN} characters.`);
      return false;
    }
    return true;
  };

  const handleReasonNext = () => {
    if (!validateReason()) return;
    setStep(STEP.CONFIRM);
  };

  const handleFinalConfirm = async () => {
    if (!validateReason()) {
      setStep(STEP.REASON);
      return;
    }
    setStep(STEP.LOADING);
    setApiError('');
    try {
      await onDecline(reason.trim());
    } catch (err) {
      setApiError(err.message || 'Could not process your decline. Please try again.');
      setStep(STEP.CONFIRM);
    }
  };

  const charCount   = reason.length;
  const isReasonOk  = reason.trim().length >= REASON_MIN;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="decline-modal-title"
      onKeyDown={handleKeyDown}
      style={{
        position: 'fixed', inset: 0,
        background: 'rgba(0,0,0,0.65)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        zIndex: 200, padding: '1rem',
      }}
    >
      <div
        ref={modalRef}
        style={{
          background: 'white', borderRadius: 16,
          width: '100%', maxWidth: 520,
          boxShadow: '0 24px 64px rgba(0,0,0,0.3)',
          overflow: 'hidden',
          maxHeight: '92vh', display: 'flex', flexDirection: 'column',
        }}
      >
        {/* ── Step: WARNING ───────────────────────────────────────────── */}
        {step === STEP.WARNING && (
          <>
            <div style={headerStyle('#fef3c7', '#92400e')}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                <WarningIcon />
                <h2 id="decline-modal-title" style={titleStyle}>Before you decline…</h2>
              </div>
            </div>
            <div style={bodyStyle}>
              <p style={paraStyle}>
                You are about to <strong>decline to sign "{documentName}"</strong>.
              </p>
              <div style={{ background: '#fef3c7', border: '1px solid #fcd34d', borderRadius: 8, padding: '0.875rem 1rem', marginBottom: '1rem' }}>
                <p style={{ margin: 0, color: '#78350f', fontSize: '0.875rem', lineHeight: 1.6, fontWeight: 600 }}>
                  This action will:
                </p>
                <ul style={{ margin: '0.5rem 0 0', paddingLeft: '1.25rem', color: '#78350f', fontSize: '0.85rem', lineHeight: 2 }}>
                  <li>Stop the entire signing workflow immediately</li>
                  <li>Cancel all pending signers downstream of you</li>
                  <li>Notify the document sender</li>
                  <li>Create a permanent, timestamped audit record</li>
                </ul>
              </div>
              <p style={{ ...paraStyle, color: '#6b7280', fontSize: '0.85rem' }}>
                This cannot be undone. The sender must void and re-send the document
                if they wish to restart the signing process.
              </p>
            </div>
            <div style={footerStyle}>
              <button ref={firstBtnRef} onClick={onCancel} style={btnSecondary} disabled={disabled}>
                Go Back — I'll Sign
              </button>
              <button onClick={() => setStep(STEP.REASON)} style={btnDanger} disabled={disabled}>
                Decline to Sign →
              </button>
            </div>
          </>
        )}

        {/* ── Step: REASON ────────────────────────────────────────────── */}
        {step === STEP.REASON && (
          <>
            <div style={headerStyle('#fee2e2', '#991b1b')}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                <DeclineIcon />
                <div>
                  <h2 id="decline-modal-title" style={titleStyle}>Decline to Sign</h2>
                  <div style={{ fontSize: '0.78rem', color: '#dc2626', marginTop: 2 }}>
                    A reason is required for legal records
                  </div>
                </div>
              </div>
            </div>
            <div style={{ ...bodyStyle, overflowY: 'auto', flex: 1 }}>
              <p style={{ ...paraStyle, marginBottom: '0.75rem', fontSize: '0.875rem' }}>
                Select a reason or type your own:
              </p>
              {/* Quick-select chips */}
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.4rem', marginBottom: '1rem' }}>
                {PREDEFINED_REASONS.map(preset => (
                  <button
                    key={preset}
                    onClick={() => selectPreset(preset)}
                    style={{
                      padding: '0.3rem 0.75rem',
                      borderRadius: 20,
                      border: `1.5px solid ${selectedPreset === preset ? '#dc2626' : '#e2e8f0'}`,
                      background: selectedPreset === preset ? '#fee2e2' : '#f8fafc',
                      color: selectedPreset === preset ? '#991b1b' : '#374151',
                      fontSize: '0.78rem', fontWeight: selectedPreset === preset ? 600 : 400,
                      cursor: 'pointer', transition: 'all 0.12s',
                    }}
                  >
                    {preset}
                  </button>
                ))}
              </div>

              {/* Custom text area */}
              <div style={{ position: 'relative' }}>
                <textarea
                  ref={textAreaRef}
                  value={reason}
                  onChange={handleTextChange}
                  placeholder="Or describe your reason here (required)…"
                  rows={4}
                  style={{
                    width: '100%', padding: '0.75rem',
                    border: `1.5px solid ${error ? '#dc2626' : '#e2e8f0'}`,
                    borderRadius: 8, fontSize: '0.9rem',
                    outline: 'none', resize: 'vertical',
                    boxSizing: 'border-box', fontFamily: 'inherit',
                    color: '#0f172a', lineHeight: 1.5,
                  }}
                />
                <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '0.25rem' }}>
                  {error
                    ? <span style={{ fontSize: '0.78rem', color: '#dc2626' }}>{error}</span>
                    : <span />}
                  <span style={{ fontSize: '0.72rem', color: charCount > REASON_MAX * 0.9 ? '#ef4444' : '#94a3b8' }}>
                    {charCount} / {REASON_MAX}
                  </span>
                </div>
              </div>
            </div>
            <div style={footerStyle}>
              <button onClick={() => setStep(STEP.WARNING)} style={btnSecondary}>Back</button>
              <button
                ref={firstBtnRef}
                onClick={handleReasonNext}
                style={{ ...btnDanger, opacity: isReasonOk ? 1 : 0.5 }}
                disabled={!isReasonOk}
              >
                Review & Confirm →
              </button>
            </div>
          </>
        )}

        {/* ── Step: CONFIRM ───────────────────────────────────────────── */}
        {step === STEP.CONFIRM && (
          <>
            <div style={headerStyle('#fee2e2', '#991b1b')}>
              <h2 id="decline-modal-title" style={titleStyle}>Confirm Decline</h2>
            </div>
            <div style={bodyStyle}>
              <p style={paraStyle}>
                Please confirm you wish to decline <strong>"{documentName}"</strong>.
              </p>
              <div style={{ background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 8, padding: '0.875rem 1rem', marginBottom: '1rem' }}>
                <div style={{ fontSize: '0.78rem', color: '#64748b', fontWeight: 600, marginBottom: '0.4rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                  Your Reason
                </div>
                <div style={{ fontSize: '0.875rem', color: '#1e293b', lineHeight: 1.6, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                  {reason.trim()}
                </div>
              </div>
              {apiError && (
                <div style={{ background: '#fee2e2', border: '1px solid #fca5a5', borderRadius: 8, padding: '0.75rem', marginBottom: '1rem', color: '#dc2626', fontSize: '0.85rem' }}>
                  {apiError}
                </div>
              )}
              <p style={{ ...paraStyle, color: '#6b7280', fontSize: '0.8rem' }}>
                By clicking <strong>Decline to Sign</strong>, this action will be permanently
                recorded in the audit trail with your identity, timestamp, IP address, and the
                reason stated above.
              </p>
            </div>
            <div style={footerStyle}>
              <button onClick={() => setStep(STEP.REASON)} style={btnSecondary}>Edit Reason</button>
              <button
                ref={firstBtnRef}
                onClick={handleFinalConfirm}
                style={btnDanger}
              >
                Decline to Sign
              </button>
            </div>
          </>
        )}

        {/* ── Step: LOADING ───────────────────────────────────────────── */}
        {step === STEP.LOADING && (
          <div style={{ padding: '3rem 2rem', textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '1rem' }}>
            <div style={{
              width: 44, height: 44,
              border: '3px solid #e5e7eb', borderTopColor: '#dc2626',
              borderRadius: '50%', animation: 'spin 0.8s linear infinite',
            }} />
            <div style={{ fontSize: '1rem', fontWeight: 600, color: '#374151' }}>
              Processing your decline…
            </div>
            <div style={{ fontSize: '0.85rem', color: '#94a3b8' }}>
              Recording audit event and notifying sender
            </div>
          </div>
        )}
      </div>

      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}

// ── Style tokens ──────────────────────────────────────────────────────────────
const headerStyle = (bg, color) => ({
  padding: '1.25rem 1.5rem',
  background: bg,
  borderBottom: `1px solid ${color}33`,
});

const titleStyle = {
  margin: 0,
  fontSize: '1.1rem',
  fontWeight: 700,
  color: '#0f172a',
  lineHeight: 1.2,
};

const bodyStyle = {
  padding: '1.25rem 1.5rem',
};

const paraStyle = {
  margin: '0 0 1rem',
  color: '#374151',
  fontSize: '0.9rem',
  lineHeight: 1.6,
};

const footerStyle = {
  padding: '0.875rem 1.5rem 1.25rem',
  borderTop: '1px solid #f1f5f9',
  display: 'flex',
  gap: '0.75rem',
  justifyContent: 'flex-end',
};

const btnSecondary = {
  padding: '0.65rem 1.25rem',
  background: '#f1f5f9',
  color: '#374151',
  border: 'none',
  borderRadius: 8,
  fontWeight: 600,
  fontSize: '0.875rem',
  cursor: 'pointer',
};

const btnDanger = {
  padding: '0.65rem 1.5rem',
  background: '#dc2626',
  color: 'white',
  border: 'none',
  borderRadius: 8,
  fontWeight: 700,
  fontSize: '0.875rem',
  cursor: 'pointer',
};

function WarningIcon() {
  return (
    <div style={{ width: 36, height: 36, borderRadius: 8, background: '#fcd34d', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
      <svg width="20" height="20" fill="none" viewBox="0 0 24 24" stroke="#92400e" strokeWidth="2">
        <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v4m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
      </svg>
    </div>
  );
}

function DeclineIcon() {
  return (
    <div style={{ width: 36, height: 36, borderRadius: 8, background: '#fca5a5', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
      <svg width="18" height="18" fill="none" viewBox="0 0 24 24" stroke="#991b1b" strokeWidth="2.5">
        <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
      </svg>
    </div>
  );
}
