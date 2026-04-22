import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import SignatureCanvas from 'react-signature-canvas';
import * as pdfjsLib from 'pdfjs-dist/build/pdf';

pdfjsLib.GlobalWorkerOptions.workerSrc =
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:5000/api';

const FIELD_LABELS = {
  signature: 'Signature',
  initials:  'Initials',
  date:      'Date',
  text:      'Text',
  checkbox:  'Check',
};
const FIELD_ICONS = {
  signature: '✍️',
  initials:  '🅰️',
  date:      '📅',
  text:      '📝',
  checkbox:  '☑️',
};

export default function SignDocument() {
  const { id } = useParams();
  const navigate = useNavigate();

  const [recipientToken] = useState(() => {
    const hash = window.location.hash;
    if (!hash.startsWith('#token=')) return null;
    const raw = decodeURIComponent(hash.slice('#token='.length));
    // Stash token in sessionStorage so refresh doesn't lose it mid-signing.
    sessionStorage.setItem(`sign-token-${window.location.pathname}`, raw);
    window.history.replaceState(null, '', window.location.pathname + window.location.search);
    return raw || null;
  });

  // Recover token from sessionStorage on refresh
  const effectiveToken = useMemo(() => {
    if (recipientToken) return recipientToken;
    return sessionStorage.getItem(`sign-token-${window.location.pathname}`) || null;
  }, [recipientToken]);

  const [pdfDoc,     setPdfDoc]     = useState(null);
  const [pageCount,  setPageCount]  = useState(0);
  const [fields,     setFields]     = useState([]);       // from /fields/:id/my
  const [values,     setValues]     = useState({});       // { field_id: value }
  const [signerInfo, setSignerInfo] = useState(null);
  const [useFields,  setUseFields]  = useState(false);    // multi-field flow?
  const [loading,    setLoading]    = useState(true);
  const [error,      setError]      = useState('');
  const [done,       setDone]       = useState(false);
  const [saving,     setSaving]     = useState(false);

  // Modal state (signature / initials)
  const [sigModal, setSigModal] = useState(null);         // field object being edited
  const [sigMode,  setSigMode]  = useState('draw');
  const [typedSig, setTypedSig] = useState('');
  const [sigFont,  setSigFont]  = useState('Dancing Script');
  const sigCanvasRef = useRef();

  // Legacy flow state
  const [legacyModal, setLegacyModal] = useState(false);

  const canvasRefs = useRef({});

  // ── 1. Load: fields (if any) + PDF ────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const token = localStorage.getItem('token');

        // Try to fetch fields for this signer (Phase 8 flow).
        // Works for public (token) and authenticated (JWT — but endpoint is token-based).
        let fieldsData = null;
        if (effectiveToken) {
          try {
            const fRes = await fetch(
              `${API_BASE}/fields/${id}/my?token=${encodeURIComponent(effectiveToken)}`
            );
            if (fRes.ok) {
              fieldsData = await fRes.json();
            }
          } catch { /* ignore */ }
        }

        if (!cancelled && fieldsData && fieldsData.fields && fieldsData.fields.length > 0) {
          setFields(fieldsData.fields.map(f => ({
            ...f,
            x_pct:      Number(f.x_pct),
            y_pct:      Number(f.y_pct),
            width_pct:  Number(f.width_pct),
            height_pct: Number(f.height_pct),
          })));
          setSignerInfo(fieldsData.signer || null);
          setUseFields(true);
        }

        // Fetch PDF bytes (public serve for token flow, authenticated serve otherwise)
        const url = effectiveToken
          ? `${API_BASE}/documents/${id}/serve/public?token=${encodeURIComponent(effectiveToken)}`
          : `${API_BASE}/documents/${id}/stream`;
        const headers = {};
        if (token && !effectiveToken) headers.Authorization = `Bearer ${token}`;

        const pdfRes = await fetch(url, { headers });
        if (!pdfRes.ok) throw new Error('Failed to fetch PDF.');
        const buf = await pdfRes.arrayBuffer();
        if (cancelled) return;

        const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
        if (cancelled) return;
        setPdfDoc(pdf);
        setPageCount(pdf.numPages);

        // Log a 'viewed' event (best-effort, non-blocking)
        if (effectiveToken) {
          fetch(`${API_BASE}/fields/${id}/view-event`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token: effectiveToken }),
          }).catch(() => {});
        }
      } catch (e) {
        if (!cancelled) setError('Could not load document. The signing link may have expired.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [id, effectiveToken]);

  // ── 2. Render each PDF page ───────────────────────────────────────────────
  useEffect(() => {
    if (!pdfDoc) return;
    let cancelled = false;
    (async () => {
      for (let p = 1; p <= pdfDoc.numPages; p++) {
        if (cancelled) return;
        const page = await pdfDoc.getPage(p);
        const viewport = page.getViewport({ scale: 1.4 });
        const canvas = canvasRefs.current[p];
        if (!canvas) continue;
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
      }
    })();
    return () => { cancelled = true; };
  }, [pdfDoc]);

  // ── 3. Field interaction helpers ──────────────────────────────────────────
  const setFieldValue = (fieldId, value) => {
    setValues(prev => ({ ...prev, [fieldId]: value }));
  };

  const renderTypedSig = useCallback((text, font) => {
    const canvas = document.createElement('canvas');
    canvas.width = 440; canvas.height = 120;
    const ctx = canvas.getContext('2d');
    ctx.font = `64px '${font}', cursive`;
    ctx.fillStyle = '#1e293b';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text || 'Your Name', 220, 65);
    return canvas.toDataURL('image/png');
  }, []);

  const openSigModal = (field) => {
    setSigModal(field);
    setSigMode('draw');
    setTypedSig('');
    setTimeout(() => sigCanvasRef.current?.clear(), 50);
  };

  const applySigModal = () => {
    if (!sigModal) return;
    let img = null;
    if (sigMode === 'draw') {
      if (!sigCanvasRef.current || sigCanvasRef.current.isEmpty()) {
        setError('Please draw your signature.'); return;
      }
      img = sigCanvasRef.current.getCanvas().toDataURL('image/png');
    } else {
      if (!typedSig.trim()) { setError('Please type your name.'); return; }
      img = renderTypedSig(typedSig, sigFont);
    }
    setFieldValue(sigModal.id, img);
    setSigModal(null);
    setError('');
  };

  // ── 4. Submit ─────────────────────────────────────────────────────────────
  const handleSubmit = async () => {
    setError('');

    // Validate required fields
    const missing = fields.filter(f => {
      if (!f.required) return false;
      if (f.field_type === 'date') return false; // auto-filled server-side
      const v = values[f.id];
      if (v === null || v === undefined || v === '') return true;
      return false;
    });
    if (missing.length > 0) {
      setError(`Please fill ${missing.length} required field${missing.length > 1 ? 's' : ''}.`);
      return;
    }

    setSaving(true);
    try {
      const valuePayload = fields
        .filter(f => {
          const v = values[f.id];
          if (f.field_type === 'date' && (v === null || v === undefined || v === '')) return true;
          return v !== null && v !== undefined && v !== '';
        })
        .map(f => ({
          field_id: f.id,
          value:    f.field_type === 'date' && !values[f.id]
            ? new Date().toISOString()
            : String(values[f.id]),
        }));

      const token = localStorage.getItem('token');
      let response;
      if (effectiveToken) {
        response = await fetch(`${API_BASE}/signers/${id}/submit-public`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: effectiveToken, values: valuePayload }),
        });
      } else if (token) {
        response = await fetch(`${API_BASE}/signers/${id}/submit`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ values: valuePayload }),
        });
      } else {
        setError('You must be signed in or use a valid signing link.');
        setSaving(false);
        return;
      }
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Signing failed.');
      sessionStorage.removeItem(`sign-token-${window.location.pathname}`);
      setDone(true);
    } catch (e) {
      setError(e.message || 'Signing failed. Please try again.');
    } finally {
      setSaving(false);
    }
  };

  // ── 5. Legacy single-signature submit (no fields placed) ──────────────────
  const handleLegacyApply = () => {
    let img = null;
    if (sigMode === 'draw') {
      if (!sigCanvasRef.current || sigCanvasRef.current.isEmpty()) {
        setError('Please draw your signature.'); return;
      }
      img = sigCanvasRef.current.getCanvas().toDataURL('image/png');
    } else {
      if (!typedSig.trim()) { setError('Please type your name.'); return; }
      img = renderTypedSig(typedSig, sigFont);
    }
    setError('');
    setLegacyModal(false);
    handleLegacySign(img);
  };

  const handleLegacySign = async (img) => {
    setSaving(true); setError('');
    try {
      const token = localStorage.getItem('token');
      let response;
      if (effectiveToken) {
        response = await fetch(`${API_BASE}/signers/${id}/sign-public`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: effectiveToken, signatureData: img, sigX: 10, sigY: 80, sigWidth: 220, sigHeight: 70, pageNumber: 1 }),
        });
      } else if (token) {
        response = await fetch(`${API_BASE}/signers/${id}/sign`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ signatureData: img, sigX: 10, sigY: 80, sigWidth: 220, sigHeight: 70, pageNumber: 1 }),
        });
      } else {
        setError('You must be signed in or use a valid signing link.');
        setSaving(false);
        return;
      }
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Signing failed.');
      sessionStorage.removeItem(`sign-token-${window.location.pathname}`);
      setDone(true);
    } catch (e) {
      setError(e.message || 'Signing failed. Please try again.');
    } finally {
      setSaving(false);
    }
  };

  // ── 6. UI: done / loading / error states ─────────────────────────────────
  if (done) return (
    <div style={s.page}>
      <div style={s.successCard}>
        <div style={{ fontSize: '3.5rem', marginBottom: '1rem' }}>✅</div>
        <h2 style={{ fontSize: '1.4rem', fontWeight: 700, color: '#0f172a', marginBottom: '0.5rem' }}>Document Signed!</h2>
        <p style={{ color: '#64748b', marginBottom: '1.5rem' }}>Your signature has been applied and recorded securely.</p>
        <button onClick={() => navigate(effectiveToken ? '/login' : '/dashboard')} style={s.btnPrimary}>
          {effectiveToken ? 'Done' : 'Go to Dashboard'}
        </button>
      </div>
    </div>
  );

  if (loading) return (
    <div style={s.page}>
      <div style={{ textAlign: 'center' }}>
        <div style={s.spinner} />
        <p style={{ color: '#64748b', marginTop: '1rem' }}>Loading document...</p>
      </div>
    </div>
  );

  if (error && !pdfDoc) return (
    <div style={s.page}>
      <div style={{ textAlign: 'center', background: 'white', borderRadius: 16, padding: '2rem', maxWidth: 380 }}>
        <div style={{ fontSize: '2.5rem', marginBottom: '0.75rem' }}>⚠️</div>
        <p style={{ color: '#dc2626', fontWeight: 600 }}>{error}</p>
      </div>
    </div>
  );

  const fonts = ['Dancing Script', 'Pacifico', 'Great Vibes', 'Caveat'];

  // ── 7. Main layout ───────────────────────────────────────────────────────
  const filledCount = fields.filter(f => {
    if (f.field_type === 'date') return true;
    const v = values[f.id];
    return v !== null && v !== undefined && v !== '';
  }).length;

  return (
    <div style={{ minHeight: '100vh', background: '#475569', display: 'flex', flexDirection: 'column' }}>
      {/* Top bar */}
      <div style={{ background: '#1a3a5c', padding: '0.75rem 1.5rem', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '0.5rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <div style={{ width: 36, height: 36, background: 'rgba(255,255,255,0.15)', borderRadius: 8, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '1.1rem' }}>✍️</div>
          <div>
            <div style={{ color: 'white', fontWeight: 800, fontSize: '1rem' }}>SecureSign</div>
            <div style={{ color: 'rgba(255,255,255,0.5)', fontSize: '0.7rem' }}>
              {signerInfo?.email ? `Signing as ${signerInfo.email}` : 'Document Signing'}
            </div>
          </div>
        </div>
        {useFields && (
          <div style={{ color: 'white', fontSize: '0.8rem', background: 'rgba(255,255,255,0.1)', padding: '0.3rem 0.75rem', borderRadius: 20 }}>
            {filledCount} / {fields.length} fields
          </div>
        )}
      </div>

      {/* Info bar */}
      {useFields && !saving && (
        <div style={{ background: '#fff7ed', borderBottom: '1px solid #fed7aa', padding: '0.6rem 1.5rem', fontSize: '0.85rem', color: '#92400e', textAlign: 'center' }}>
          Click each highlighted field to fill it. When done, click <strong>Submit</strong>.
        </div>
      )}
      {!useFields && !saving && (
        <div style={{ background: '#fff7ed', borderBottom: '1px solid #fed7aa', padding: '0.65rem 1.5rem', fontSize: '0.875rem', color: '#92400e' }}>
          Please review the document, then click <strong>Sign Document</strong> to proceed.
        </div>
      )}
      {error && <div style={{ background: '#fee2e2', color: '#dc2626', padding: '0.6rem 1.5rem', fontSize: '0.85rem', textAlign: 'center' }}>{error}</div>}
      {saving && (
        <div style={{ background: '#eff6ff', borderBottom: '1px solid #bfdbfe', padding: '0.6rem 1.5rem', display: 'flex', alignItems: 'center', gap: '0.75rem', fontSize: '0.875rem', color: '#1d4ed8', justifyContent: 'center' }}>
          <div style={s.spinnerSm} /> Applying your signature...
        </div>
      )}

      {/* PDF view */}
      <div style={{ flex: 1, overflow: 'auto', padding: '1rem' }}>
        <div style={{ maxWidth: 900, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          {Array.from({ length: pageCount }, (_, i) => i + 1).map(pageNum => (
            <div key={pageNum} style={{ position: 'relative', boxShadow: '0 2px 8px rgba(0,0,0,0.25)', background: 'white', borderRadius: 6, overflow: 'hidden' }}>
              <div style={{ position: 'relative', width: '100%' }}>
                <canvas
                  ref={el => { if (el) canvasRefs.current[pageNum] = el; }}
                  style={{ display: 'block', width: '100%', height: 'auto' }}
                />

                {useFields && fields.filter(f => f.page_number === pageNum).map(f => {
                  const filled = (f.field_type === 'date') || (values[f.id] !== undefined && values[f.id] !== '');
                  return (
                    <FieldOverlay key={f.id}
                                  field={f}
                                  filled={filled}
                                  value={values[f.id]}
                                  onClick={() => handleFieldClick(f, setValues, values, openSigModal)} />
                  );
                })}

                {!useFields && (
                  <div style={{ position: 'absolute', top: 8, right: 8, background: 'rgba(0,0,0,0.6)', color: 'white', padding: '2px 8px', borderRadius: 4, fontSize: '0.7rem', fontWeight: 600 }}>
                    Page {pageNum}
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Bottom action bar */}
      <div style={{ background: 'white', borderTop: '2px solid #e5e7eb', padding: '1rem 1.5rem', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '1.5rem', flexWrap: 'wrap' }}>
        {useFields ? (
          <button onClick={handleSubmit} disabled={saving}
            style={{ padding: '0.9rem 2.5rem', background: '#16a34a', color: 'white', border: 'none', borderRadius: 8, fontWeight: 800, fontSize: '1rem', cursor: saving ? 'wait' : 'pointer', display: 'flex', alignItems: 'center', gap: '0.6rem', boxShadow: '0 4px 12px rgba(22,163,74,0.35)' }}>
            {saving ? 'Submitting...' : `✓ Submit${filledCount < fields.length ? ` (${filledCount}/${fields.length})` : ''}`}
          </button>
        ) : (
          <button onClick={() => { setError(''); setLegacyModal(true); }} disabled={saving}
            style={{ padding: '0.9rem 2.5rem', background: '#f59e0b', color: 'white', border: 'none', borderRadius: 8, fontWeight: 800, fontSize: '1rem', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '0.6rem', boxShadow: '0 4px 12px rgba(245,158,11,0.35)' }}>
            ✍️ Sign Document
          </button>
        )}
      </div>

      {/* Text field modal (for text type) */}
      {sigModal && sigModal.field_type === 'text' && (
        <TextFieldModal field={sigModal} initial={values[sigModal.id] || ''}
          onCancel={() => setSigModal(null)}
          onApply={(v) => { setFieldValue(sigModal.id, v); setSigModal(null); }} />
      )}

      {/* Signature / initials modal */}
      {sigModal && (sigModal.field_type === 'signature' || sigModal.field_type === 'initials') && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100, padding: '1rem' }}>
          <div style={{ background: 'white', borderRadius: 16, width: '100%', maxWidth: 520, boxShadow: '0 24px 64px rgba(0,0,0,0.3)', overflow: 'hidden' }}>
            <div style={{ padding: '1.5rem 1.5rem 0', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
              <div>
                <div style={{ fontSize: '1.1rem', fontWeight: 700, color: '#0f172a' }}>
                  Add Your {FIELD_LABELS[sigModal.field_type]}
                </div>
                <div style={{ fontSize: '0.8rem', color: '#64748b', marginTop: 2 }}>Draw or type below</div>
              </div>
              <button onClick={() => setSigModal(null)} style={{ background: '#f1f5f9', border: 'none', width: 32, height: 32, borderRadius: '50%', cursor: 'pointer', fontSize: '0.9rem', color: '#64748b' }}>✕</button>
            </div>

            <div style={{ display: 'flex', gap: 4, padding: '1rem 1.5rem 0', borderBottom: '1px solid #f1f5f9' }}>
              {[{ id: 'draw', label: '✏️ Draw' }, { id: 'type', label: '⌨️ Type' }].map(m => (
                <button key={m.id} onClick={() => { setSigMode(m.id); setError(''); }}
                  style={{ padding: '0.5rem 1.25rem', border: 'none', background: 'transparent', cursor: 'pointer', fontSize: '0.875rem', fontWeight: sigMode === m.id ? 700 : 500, color: sigMode === m.id ? '#2563eb' : '#64748b', borderBottom: `2px solid ${sigMode === m.id ? '#2563eb' : 'transparent'}`, marginBottom: -1 }}>
                  {m.label}
                </button>
              ))}
            </div>

            <div style={{ padding: '1.25rem 1.5rem' }}>
              {sigMode === 'draw' && (
                <>
                  <div style={{ border: '1.5px solid #e2e8f0', borderRadius: 8, background: '#fafafa', overflow: 'hidden', marginBottom: '0.5rem' }}>
                    <SignatureCanvas ref={sigCanvasRef} penColor="#1e3a5f"
                      canvasProps={{ style: { width: '100%', height: 150, display: 'block', touchAction: 'none' } }} />
                  </div>
                  <div style={{ fontSize: '0.72rem', color: '#94a3b8', textAlign: 'center', marginBottom: '0.5rem' }}>Sign using your mouse or finger</div>
                  <button onClick={() => sigCanvasRef.current?.clear()} style={{ padding: '0.3rem 0.75rem', background: '#f1f5f9', border: '1px solid #e2e8f0', borderRadius: 6, cursor: 'pointer', fontSize: '0.78rem', color: '#374151' }}>Clear</button>
                </>
              )}
              {sigMode === 'type' && (
                <>
                  <input value={typedSig} onChange={e => setTypedSig(e.target.value)} placeholder="Type your name"
                    style={{ width: '100%', padding: '0.75rem', border: '1.5px solid #e2e8f0', borderRadius: 8, fontSize: '0.9rem', outline: 'none', marginBottom: '1rem', boxSizing: 'border-box' }} autoFocus />
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.5rem' }}>
                    {fonts.map(f => (
                      <div key={f} onClick={() => setSigFont(f)}
                        style={{ border: `1.5px solid ${sigFont === f ? '#2563eb' : '#e2e8f0'}`, borderRadius: 8, padding: '0.75rem', background: sigFont === f ? '#eff6ff' : '#fafafa', cursor: 'pointer', textAlign: 'center', minHeight: 60, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                        <span style={{ fontFamily: `'${f}', cursive`, fontSize: '1.4rem', color: '#1e3a5f' }}>{typedSig || 'Preview'}</span>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </div>

            <div style={{ padding: '1rem 1.5rem 1.5rem', display: 'flex', gap: '0.75rem', justifyContent: 'flex-end', borderTop: '1px solid #f1f5f9', marginTop: '0.75rem' }}>
              <button onClick={() => setSigModal(null)} style={{ padding: '0.7rem 1.25rem', background: '#f1f5f9', color: '#374151', border: 'none', borderRadius: 8, fontWeight: 600, fontSize: '0.9rem', cursor: 'pointer' }}>Cancel</button>
              <button onClick={applySigModal} style={{ padding: '0.7rem 1.5rem', background: '#2563eb', color: 'white', border: 'none', borderRadius: 8, fontWeight: 700, fontSize: '0.9rem', cursor: 'pointer' }}>
                Apply →
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Legacy (no-fields) signature modal */}
      {legacyModal && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100, padding: '1rem' }}>
          <div style={{ background: 'white', borderRadius: 16, width: '100%', maxWidth: 520, boxShadow: '0 24px 64px rgba(0,0,0,0.3)', overflow: 'hidden' }}>
            <div style={{ padding: '1.5rem 1.5rem 0', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
              <div>
                <div style={{ fontSize: '1.1rem', fontWeight: 700, color: '#0f172a' }}>Add Your Signature</div>
                <div style={{ fontSize: '0.8rem', color: '#64748b', marginTop: 2 }}>Draw or type your signature below</div>
              </div>
              <button onClick={() => setLegacyModal(false)} style={{ background: '#f1f5f9', border: 'none', width: 32, height: 32, borderRadius: '50%', cursor: 'pointer', fontSize: '0.9rem', color: '#64748b' }}>✕</button>
            </div>
            <div style={{ display: 'flex', gap: 4, padding: '1rem 1.5rem 0', borderBottom: '1px solid #f1f5f9' }}>
              {[{ id: 'draw', label: '✏️ Draw' }, { id: 'type', label: '⌨️ Type' }].map(m => (
                <button key={m.id} onClick={() => { setSigMode(m.id); setError(''); }}
                  style={{ padding: '0.5rem 1.25rem', border: 'none', background: 'transparent', cursor: 'pointer', fontSize: '0.875rem', fontWeight: sigMode === m.id ? 700 : 500, color: sigMode === m.id ? '#2563eb' : '#64748b', borderBottom: `2px solid ${sigMode === m.id ? '#2563eb' : 'transparent'}`, marginBottom: -1 }}>
                  {m.label}
                </button>
              ))}
            </div>
            <div style={{ padding: '1.25rem 1.5rem' }}>
              {sigMode === 'draw' && (
                <>
                  <div style={{ border: '1.5px solid #e2e8f0', borderRadius: 8, background: '#fafafa', overflow: 'hidden', marginBottom: '0.5rem' }}>
                    <SignatureCanvas ref={sigCanvasRef} penColor="#1e3a5f"
                      canvasProps={{ style: { width: '100%', height: 150, display: 'block', touchAction: 'none' } }} />
                  </div>
                  <button onClick={() => sigCanvasRef.current?.clear()} style={{ padding: '0.3rem 0.75rem', background: '#f1f5f9', border: '1px solid #e2e8f0', borderRadius: 6, cursor: 'pointer', fontSize: '0.78rem', color: '#374151' }}>Clear</button>
                </>
              )}
              {sigMode === 'type' && (
                <>
                  <input value={typedSig} onChange={e => setTypedSig(e.target.value)} placeholder="Type your full name"
                    style={{ width: '100%', padding: '0.75rem', border: '1.5px solid #e2e8f0', borderRadius: 8, fontSize: '0.9rem', outline: 'none', marginBottom: '1rem', boxSizing: 'border-box' }} autoFocus />
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.5rem' }}>
                    {fonts.map(f => (
                      <div key={f} onClick={() => setSigFont(f)}
                        style={{ border: `1.5px solid ${sigFont === f ? '#2563eb' : '#e2e8f0'}`, borderRadius: 8, padding: '0.75rem', background: sigFont === f ? '#eff6ff' : '#fafafa', cursor: 'pointer', textAlign: 'center', minHeight: 60, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                        <span style={{ fontFamily: `'${f}', cursive`, fontSize: '1.4rem', color: '#1e3a5f' }}>{typedSig || 'Preview'}</span>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </div>
            {error && <div style={{ margin: '0 1.5rem', padding: '0.6rem 0.9rem', background: '#fee2e2', color: '#dc2626', borderRadius: 6, fontSize: '0.8rem' }}>{error}</div>}
            <div style={{ padding: '1rem 1.5rem 1.5rem', display: 'flex', gap: '0.75rem', justifyContent: 'flex-end', borderTop: '1px solid #f1f5f9', marginTop: '0.75rem' }}>
              <button onClick={() => setLegacyModal(false)} style={{ padding: '0.7rem 1.25rem', background: '#f1f5f9', color: '#374151', border: 'none', borderRadius: 8, fontWeight: 600, fontSize: '0.9rem', cursor: 'pointer' }}>Cancel</button>
              <button onClick={handleLegacyApply} style={{ padding: '0.7rem 1.5rem', background: '#2563eb', color: 'white', border: 'none', borderRadius: 8, fontWeight: 700, fontSize: '0.9rem', cursor: 'pointer' }}>
                Apply Signature →
              </button>
            </div>
          </div>
        </div>
      )}

      <link rel="preconnect" href="https://fonts.googleapis.com" />
      <link href="https://fonts.googleapis.com/css2?family=Dancing+Script:wght@700&family=Pacifico&family=Great+Vibes&family=Caveat:wght@700&display=swap" rel="stylesheet" />
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────────
// Field interaction dispatcher — opens modal for signature/text, toggles for checkbox
// ──────────────────────────────────────────────────────────────────────────────
function handleFieldClick(field, setValues, values, openSigModal) {
  switch (field.field_type) {
    case 'signature':
    case 'initials':
      openSigModal(field);
      return;
    case 'checkbox': {
      const cur = values[field.id];
      const next = cur === 'true' ? 'false' : 'true';
      setValues(prev => ({ ...prev, [field.id]: next }));
      return;
    }
    case 'text':
      openSigModal(field); // reuse the modal state, handled via text branch
      return;
    case 'date':
      // Auto-filled server-side; clicking toggles a local "override with now" value.
      setValues(prev => ({ ...prev, [field.id]: new Date().toISOString() }));
      return;
    default: return;
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Renders a field overlay on top of a PDF page
// ──────────────────────────────────────────────────────────────────────────────
function FieldOverlay({ field, filled, value, onClick }) {
  const baseColor = filled ? '#16a34a' : '#f59e0b';
  const bg        = filled ? 'rgba(22,163,74,0.18)' : 'rgba(245,158,11,0.2)';
  const border    = filled ? '2px solid #16a34a' : '2px dashed #f59e0b';

  const content = (() => {
    if (!filled) {
      return (
        <span style={{ fontSize: '0.7rem', fontWeight: 700, color: baseColor, pointerEvents: 'none' }}>
          {FIELD_ICONS[field.field_type]} {FIELD_LABELS[field.field_type]}{field.required ? ' *' : ''}
        </span>
      );
    }
    if (field.field_type === 'signature' || field.field_type === 'initials') {
      return <img src={value} alt="" style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain', pointerEvents: 'none' }} />;
    }
    if (field.field_type === 'checkbox') {
      const checked = value === 'true';
      return <span style={{ fontSize: '1rem', pointerEvents: 'none' }}>{checked ? '☑' : '☐'}</span>;
    }
    if (field.field_type === 'date') {
      const d = (value || new Date().toISOString()).slice(0, 10);
      return <span style={{ fontSize: '0.75rem', color: '#0f172a', pointerEvents: 'none' }}>{d}</span>;
    }
    if (field.field_type === 'text') {
      return <span style={{ fontSize: '0.75rem', color: '#0f172a', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', pointerEvents: 'none' }}>{value}</span>;
    }
    return null;
  })();

  return (
    <div onClick={onClick}
         style={{
           position: 'absolute',
           left:   `${field.x_pct}%`,
           top:    `${field.y_pct}%`,
           width:  `${field.width_pct}%`,
           height: `${field.height_pct}%`,
           background: bg,
           border,
           borderRadius: 3,
           display: 'flex', alignItems: 'center', justifyContent: 'center',
           cursor: 'pointer',
           boxSizing: 'border-box',
           overflow: 'hidden',
         }}>
      {content}
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────────
// Small text-field modal
// ──────────────────────────────────────────────────────────────────────────────
function TextFieldModal({ field, initial, onCancel, onApply }) {
  const [v, setV] = useState(initial);
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100, padding: '1rem' }}>
      <div style={{ background: 'white', borderRadius: 16, width: '100%', maxWidth: 460, boxShadow: '0 24px 64px rgba(0,0,0,0.3)', overflow: 'hidden' }}>
        <div style={{ padding: '1.25rem 1.5rem', borderBottom: '1px solid #f1f5f9' }}>
          <div style={{ fontSize: '1.05rem', fontWeight: 700, color: '#0f172a' }}>
            {field.label || 'Enter text'}
          </div>
        </div>
        <div style={{ padding: '1.25rem 1.5rem' }}>
          <textarea
            value={v}
            onChange={(e) => setV(e.target.value.slice(0, 500))}
            placeholder="Type here…"
            autoFocus
            style={{ width: '100%', minHeight: 90, padding: '0.75rem', border: '1.5px solid #e2e8f0', borderRadius: 8, fontSize: '0.9rem', outline: 'none', resize: 'vertical', boxSizing: 'border-box' }} />
          <div style={{ textAlign: 'right', fontSize: '0.7rem', color: '#94a3b8', marginTop: 4 }}>
            {v.length} / 500
          </div>
        </div>
        <div style={{ padding: '0.75rem 1.5rem 1.25rem', display: 'flex', gap: '0.75rem', justifyContent: 'flex-end' }}>
          <button onClick={onCancel} style={{ padding: '0.6rem 1.1rem', background: '#f1f5f9', color: '#374151', border: 'none', borderRadius: 8, fontWeight: 600, fontSize: '0.875rem', cursor: 'pointer' }}>Cancel</button>
          <button onClick={() => onApply(v)} style={{ padding: '0.6rem 1.25rem', background: '#2563eb', color: 'white', border: 'none', borderRadius: 8, fontWeight: 700, fontSize: '0.875rem', cursor: 'pointer' }}>Apply</button>
        </div>
      </div>
    </div>
  );
}

const s = {
  page:      { minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#f1f5f9', flexDirection: 'column', padding: '1rem' },
  successCard:{ textAlign: 'center', background: 'white', borderRadius: 16, padding: '3rem 2rem', boxShadow: '0 4px 24px rgba(0,0,0,0.08)', maxWidth: 400, width: '100%' },
  btnPrimary: { padding: '0.75rem 2rem', background: '#2563eb', color: 'white', border: 'none', borderRadius: 8, fontWeight: 700, fontSize: '0.95rem', cursor: 'pointer' },
  spinner:   { width: 40, height: 40, border: '3px solid #e5e7eb', borderTopColor: '#2563eb', borderRadius: '50%', animation: 'spin 0.8s linear infinite', margin: '0 auto' },
  spinnerSm: { width: 16, height: 16, border: '2px solid #bfdbfe', borderTopColor: '#2563eb', borderRadius: '50%', animation: 'spin 0.8s linear infinite', flexShrink: 0 },
};
