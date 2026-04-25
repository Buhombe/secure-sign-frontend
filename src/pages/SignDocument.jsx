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
  checkbox:  'Checkbox',
};
const FIELD_ICONS = {
  signature: '✍️',
  initials:  '🅰️',
  date:      '📅',
  text:      '📝',
  checkbox:  '☑️',
};

// ── Sort fields: top-to-bottom, page-by-page (DocuSign order) ────────────────
function sortedFields(fields) {
  return [...fields].sort((a, b) => {
    if (a.page_number !== b.page_number) return a.page_number - b.page_number;
    if (Math.abs(a.y_pct - b.y_pct) > 2) return a.y_pct - b.y_pct;
    return a.x_pct - b.x_pct;
  });
}

// ── Is a field considered "filled"? ──────────────────────────────────────────
function isFilled(field, values) {
  if (field.field_type === 'date') return true; // auto-filled server-side
  const v = values[field.id];
  return v !== null && v !== undefined && v !== '';
}

export default function SignDocument() {
  const { id } = useParams();
  const navigate = useNavigate();

  // ── Token recovery ────────────────────────────────────────────────────────
  const [recipientToken] = useState(() => {
    const hash = window.location.hash;
    if (!hash.startsWith('#token=')) return null;
    const raw = decodeURIComponent(hash.slice('#token='.length));
    sessionStorage.setItem(`sign-token-${window.location.pathname}`, raw);
    window.history.replaceState(null, '', window.location.pathname + window.location.search);
    return raw || null;
  });
  const effectiveToken = useMemo(() => {
    if (recipientToken) return recipientToken;
    return sessionStorage.getItem(`sign-token-${window.location.pathname}`) || null;
  }, [recipientToken]);

  // ── Core state ────────────────────────────────────────────────────────────
  const [pdfDoc,      setPdfDoc]      = useState(null);
  const [pageCount,   setPageCount]   = useState(0);
  const [fields,      setFields]      = useState([]);
  const [values,      setValues]      = useState({});
  const [signerInfo,  setSignerInfo]  = useState(null);
  const [useFields,   setUseFields]   = useState(false);
  const [loading,     setLoading]     = useState(true);
  const [error,       setError]       = useState('');
  const [done,        setDone]        = useState(false);
  const [saving,      setSaving]      = useState(false);
  const [docTitle,    setDocTitle]    = useState('');

  // ── Guided navigation ─────────────────────────────────────────────────────
  const [activeFieldIdx,  setActiveFieldIdx]  = useState(0);
  const [showValidation,  setShowValidation]  = useState(false);

  // ── Signature modal state ─────────────────────────────────────────────────
  const [sigModal,  setSigModal]  = useState(null);
  const [sigMode,   setSigMode]   = useState('draw');
  const [typedSig,  setTypedSig]  = useState('');
  const [sigFont,   setSigFont]   = useState('Dancing Script');
  const sigCanvasRef = useRef();

  // ── Legacy flow ───────────────────────────────────────────────────────────
  const [legacyModal, setLegacyModal] = useState(false);

  const canvasRefs = useRef({});
  const fieldRefs  = useRef({});

  // ── 1. Load fields + PDF ──────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const token = localStorage.getItem('token');
        let fieldsData = null;

        if (effectiveToken) {
          try {
            const fRes = await fetch(
              `${API_BASE}/fields/${id}/my?token=${encodeURIComponent(effectiveToken)}`
            );
            if (fRes.ok) fieldsData = await fRes.json();
          } catch { /* ignore */ }
        }

        if (!cancelled && fieldsData?.fields?.length > 0) {
          const parsed = fieldsData.fields.map(f => ({
            ...f,
            x_pct:      Number(f.x_pct),
            y_pct:      Number(f.y_pct),
            width_pct:  Number(f.width_pct),
            height_pct: Number(f.height_pct),
          }));
          setFields(sortedFields(parsed));
          setSignerInfo(fieldsData.signer || null);
          setUseFields(true);
        }

        // Fetch document title
        try {
          const headers = token ? { Authorization: `Bearer ${token}` } : {};
          const docRes = await fetch(`${API_BASE}/documents/${id}`, { headers });
          if (docRes.ok) {
            const docData = await docRes.json();
            setDocTitle(docData.document?.original_name || '');
          }
        } catch { /* ignore */ }

        const url = effectiveToken
          ? `${API_BASE}/documents/${id}/serve/signer?token=${encodeURIComponent(effectiveToken)}`
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

  // ── 2. Render PDF pages ───────────────────────────────────────────────────
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
        canvas.width  = viewport.width;
        canvas.height = viewport.height;
        await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
      }
    })();
    return () => { cancelled = true; };
  }, [pdfDoc]);

  // ── 3. Auto-scroll to active field ───────────────────────────────────────
  useEffect(() => {
    if (!useFields || fields.length === 0) return;
    const f = fields[activeFieldIdx];
    if (!f) return;
    const el = fieldRefs.current[f.id];
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [activeFieldIdx, useFields, fields]);

  // ── 4. Helpers ────────────────────────────────────────────────────────────
  const setFieldValue = (fieldId, value) => {
    setValues(prev => ({ ...prev, [fieldId]: value }));
    setShowValidation(false);
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
    setError('');
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
    advanceToNext(sigModal.id);
  };

  // ── 5. Guided navigation ──────────────────────────────────────────────────
  const requiredFields = useMemo(
    () => fields.filter(f => f.required && f.field_type !== 'date'),
    [fields]
  );

  const filledCount = useMemo(
    () => fields.filter(f => isFilled(f, values)).length,
    [fields, values]
  );

  const requiredFilledCount = useMemo(
    () => requiredFields.filter(f => isFilled(f, values)).length,
    [requiredFields, values]
  );

  const allRequiredFilled = requiredFilledCount === requiredFields.length;
  const progressPct = requiredFields.length > 0
    ? Math.round((requiredFilledCount / requiredFields.length) * 100)
    : 100;

  const advanceToNext = (justFilledId) => {
    const justIdx = fields.findIndex(f => f.id === justFilledId);
    const searchFrom = justIdx >= 0 ? justIdx + 1 : 0;
    for (let i = searchFrom; i < fields.length; i++) {
      if (fields[i].required && fields[i].field_type !== 'date' && !isFilled(fields[i], values)) {
        setActiveFieldIdx(i); return;
      }
    }
    for (let i = 0; i < searchFrom; i++) {
      if (fields[i].required && fields[i].field_type !== 'date' && !isFilled(fields[i], values)) {
        setActiveFieldIdx(i); return;
      }
    }
    setActiveFieldIdx(fields.length - 1);
  };

  const goToNextField = () => {
    for (let i = activeFieldIdx + 1; i < fields.length; i++) {
      if (fields[i].required && fields[i].field_type !== 'date' && !isFilled(fields[i], values)) {
        setActiveFieldIdx(i); return;
      }
    }
    for (let i = 0; i <= activeFieldIdx; i++) {
      if (fields[i] && fields[i].required && fields[i].field_type !== 'date' && !isFilled(fields[i], values)) {
        setActiveFieldIdx(i); return;
      }
    }
  };

  const handleFieldClick = (field) => {
    setActiveFieldIdx(fields.findIndex(f => f.id === field.id));
    switch (field.field_type) {
      case 'signature':
      case 'initials':
      case 'text':
        openSigModal(field); break;
      case 'checkbox': {
        const cur = values[field.id];
        setFieldValue(field.id, cur === 'true' ? 'false' : 'true');
        advanceToNext(field.id); break;
      }
      case 'date':
        setFieldValue(field.id, new Date().toISOString());
        advanceToNext(field.id); break;
      default: break;
    }
  };

  // ── 6. Submit ─────────────────────────────────────────────────────────────
  const handleSubmit = async () => {
    setError('');
    const missing = fields.filter(f => f.required && !isFilled(f, values));
    if (missing.length > 0) {
      setShowValidation(true);
      const firstMissingIdx = fields.findIndex(f => f.required && !isFilled(f, values));
      setActiveFieldIdx(firstMissingIdx);
      setError(`Please complete ${missing.length} required field${missing.length > 1 ? 's' : ''} before submitting.`);
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
          value: f.field_type === 'date' && !values[f.id]
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
        setSaving(false); return;
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

  // ── 7. Legacy flow ────────────────────────────────────────────────────────
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
        setSaving(false); return;
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

  // ── 8. Done screen ────────────────────────────────────────────────────────
  if (done) return (
    <div style={s.page}>
      <div style={s.successCard}>
        <div style={{ display: 'flex', justifyContent: 'center', marginBottom: '0.5rem' }}>
          <div style={{ width: 72, height: 72, background: '#dcfce7', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '2rem' }}>✓</div>
        </div>
        <h2 style={{ fontSize: '1.5rem', fontWeight: 800, color: '#0f172a', margin: '0.75rem 0 0.5rem' }}>
          You're all done!
        </h2>
        <p style={{ color: '#64748b', fontSize: '0.95rem', margin: '0 0 0.25rem' }}>
          Your signature has been applied securely.
        </p>
        {docTitle && (
          <p style={{ color: '#94a3b8', fontSize: '0.82rem', margin: '0 0 1.75rem', fontStyle: 'italic' }}>
            "{docTitle}"
          </p>
        )}

        <div style={{ display: 'flex', gap: 0, background: '#f8fafc', borderRadius: 12, border: '1px solid #e5e7eb', overflow: 'hidden', marginBottom: '1.25rem' }}>
          {[
            { value: fields.length || 1, label: `Field${(fields.length || 1) !== 1 ? 's' : ''} signed`, color: '#16a34a' },
            { value: '🔒', label: 'Encrypted & stored', color: '#2563eb' },
            { value: '📧', label: 'Confirmation sent', color: '#f59e0b' },
          ].map((stat, i) => (
            <div key={i} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '0.9rem 0.5rem', borderLeft: i > 0 ? '1px solid #e5e7eb' : 'none' }}>
              <span style={{ fontSize: '1.4rem', fontWeight: 800, color: stat.color }}>{stat.value}</span>
              <span style={{ fontSize: '0.7rem', color: '#64748b', marginTop: 3, textAlign: 'center' }}>{stat.label}</span>
            </div>
          ))}
        </div>

        <p style={{ color: '#94a3b8', fontSize: '0.78rem', marginBottom: '1.75rem' }}>
          A copy will be emailed to all parties once everyone has signed.
        </p>

        <button onClick={() => effectiveToken ? window.close() : navigate('/dashboard')} style={s.btnPrimary}>
          {effectiveToken ? 'Close' : 'Go to Dashboard'}
        </button>
      </div>
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );

  if (loading) return (
    <div style={s.page}>
      <div style={{ textAlign: 'center' }}>
        <div style={s.spinner} />
        <p style={{ color: '#64748b', marginTop: '1rem' }}>Loading document...</p>
      </div>
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );

  if (error && !pdfDoc) return (
    <div style={s.page}>
      <div style={{ textAlign: 'center', background: 'white', borderRadius: 16, padding: '2rem', maxWidth: 380 }}>
        <div style={{ fontSize: '2.5rem', marginBottom: '0.75rem' }}>⚠️</div>
        <p style={{ color: '#dc2626', fontWeight: 600 }}>{error}</p>
      </div>
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );

  const fonts       = ['Dancing Script', 'Pacifico', 'Great Vibes', 'Caveat'];
  const activeField = fields[activeFieldIdx] || null;

  // ── 9. Main render ────────────────────────────────────────────────────────
  return (
    <div style={{ minHeight: '100vh', background: '#475569', display: 'flex', flexDirection: 'column' }}>

      {/* TOP BAR */}
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
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            <div style={{ width: 130, height: 6, background: 'rgba(255,255,255,0.2)', borderRadius: 3, overflow: 'hidden' }}>
              <div style={{ width: `${progressPct}%`, height: '100%', background: progressPct === 100 ? '#16a34a' : '#f59e0b', borderRadius: 3, transition: 'width 0.3s ease' }} />
            </div>
            <span style={{ color: 'white', fontSize: '0.78rem', fontWeight: 700 }}>{progressPct}%</span>
            <div style={{ color: 'rgba(255,255,255,0.7)', fontSize: '0.75rem', background: 'rgba(255,255,255,0.1)', padding: '0.25rem 0.65rem', borderRadius: 20 }}>
              {requiredFilledCount}/{requiredFields.length} required
            </div>
          </div>
        )}
      </div>

      {/* GUIDANCE BAR */}
      {useFields && !saving && (
        <div style={{ background: allRequiredFilled ? '#14532d' : '#1e40af', padding: '0.6rem 1.5rem', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '0.5rem', transition: 'background 0.3s' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', color: 'white', fontSize: '0.83rem' }}>
            {allRequiredFilled ? (
              <><span>✅</span><span>All required fields completed — ready to submit!</span></>
            ) : activeField ? (
              <>
                <span>{FIELD_ICONS[activeField.field_type]}</span>
                <span>
                  Click the <strong style={{ color: '#fbbf24' }}>highlighted field</strong> to add your {FIELD_LABELS[activeField.field_type].toLowerCase()}
                  {activeField.required && <span style={{ color: '#fca5a5' }}> *required</span>}
                </span>
              </>
            ) : (
              <span>Click any highlighted field to fill it</span>
            )}
          </div>
          {!allRequiredFilled && (
            <button onClick={goToNextField}
              style={{ padding: '0.3rem 0.85rem', background: 'rgba(255,255,255,0.15)', color: 'white', border: '1px solid rgba(255,255,255,0.3)', borderRadius: 6, fontSize: '0.78rem', fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap' }}>
              Next field →
            </button>
          )}
        </div>
      )}

      {!useFields && !saving && (
        <div style={{ background: '#fff7ed', borderBottom: '1px solid #fed7aa', padding: '0.65rem 1.5rem', fontSize: '0.875rem', color: '#92400e' }}>
          Please review the document, then click <strong>Sign Document</strong> to proceed.
        </div>
      )}

      {error && (
        <div style={{ background: '#fee2e2', color: '#dc2626', padding: '0.6rem 1.5rem', fontSize: '0.85rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <span>⚠️</span> {error}
        </div>
      )}
      {saving && (
        <div style={{ background: '#eff6ff', borderBottom: '1px solid #bfdbfe', padding: '0.6rem 1.5rem', display: 'flex', alignItems: 'center', gap: '0.75rem', fontSize: '0.875rem', color: '#1d4ed8', justifyContent: 'center' }}>
          <div style={s.spinnerSm} /> Applying your signature...
        </div>
      )}

      {/* PDF VIEW */}
      <div style={{ flex: 1, overflow: 'auto', padding: '1rem' }}>
        <div style={{ maxWidth: 900, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          {Array.from({ length: pageCount }, (_, i) => i + 1).map(pageNum => (
            <div key={pageNum} style={{ position: 'relative', boxShadow: '0 2px 8px rgba(0,0,0,0.25)', background: 'white', borderRadius: 6, overflow: 'hidden' }}>
              <div style={{ position: 'relative', width: '100%' }}>
                <canvas
                  ref={el => { if (el) canvasRefs.current[pageNum] = el; }}
                  style={{ display: 'block', width: '100%', height: 'auto' }}
                />
                {useFields && fields.filter(f => f.page_number === pageNum).map(f => (
                  <FieldOverlay
                    key={f.id}
                    field={f}
                    filled={isFilled(f, values)}
                    value={values[f.id]}
                    isActive={activeField?.id === f.id}
                    isMissing={showValidation && f.required && !isFilled(f, values) && f.field_type !== 'date'}
                    fieldRef={el => { if (el) fieldRefs.current[f.id] = el; }}
                    onClick={() => handleFieldClick(f)}
                  />
                ))}
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

      {/* BOTTOM ACTION BAR */}
      <div style={{ background: 'white', borderTop: '2px solid #e5e7eb', padding: '1rem 1.5rem', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '1rem' }}>
        {useFields ? (
          <>
            <div style={{ fontSize: '0.82rem', color: '#64748b' }}>
              {filledCount < fields.length
                ? <span><strong style={{ color: '#0f172a' }}>{fields.length - filledCount}</strong> field{fields.length - filledCount !== 1 ? 's' : ''} remaining</span>
                : <span style={{ color: '#16a34a', fontWeight: 700 }}>✓ All fields completed</span>
              }
            </div>
            <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center' }}>
              {!allRequiredFilled && (
                <button onClick={goToNextField}
                  style={{ padding: '0.7rem 1.25rem', background: '#f1f5f9', color: '#374151', border: '1px solid #e2e8f0', borderRadius: 8, fontWeight: 600, fontSize: '0.875rem', cursor: 'pointer' }}>
                  Next field →
                </button>
              )}
              <button onClick={handleSubmit} disabled={saving}
                style={{
                  padding: '0.85rem 2rem',
                  background: allRequiredFilled ? '#16a34a' : '#94a3b8',
                  color: 'white', border: 'none', borderRadius: 8,
                  fontWeight: 800, fontSize: '0.95rem',
                  cursor: saving ? 'wait' : allRequiredFilled ? 'pointer' : 'not-allowed',
                  display: 'flex', alignItems: 'center', gap: '0.5rem',
                  boxShadow: allRequiredFilled ? '0 4px 12px rgba(22,163,74,0.35)' : 'none',
                  transition: 'all 0.2s ease',
                }}>
                {saving
                  ? <><div style={s.spinnerSm} /> Submitting...</>
                  : allRequiredFilled
                    ? '✓ Submit Signature'
                    : `Complete fields (${requiredFilledCount}/${requiredFields.length})`
                }
              </button>
            </div>
          </>
        ) : (
          <div style={{ width: '100%', display: 'flex', justifyContent: 'center' }}>
            <button onClick={() => { setError(''); setLegacyModal(true); }} disabled={saving}
              style={{ padding: '0.9rem 2.5rem', background: '#f59e0b', color: 'white', border: 'none', borderRadius: 8, fontWeight: 800, fontSize: '1rem', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '0.6rem', boxShadow: '0 4px 12px rgba(245,158,11,0.35)' }}>
              ✍️ Sign Document
            </button>
          </div>
        )}
      </div>

      {/* TEXT FIELD MODAL */}
      {sigModal && sigModal.field_type === 'text' && (
        <TextFieldModal
          field={sigModal}
          initial={values[sigModal.id] || ''}
          onCancel={() => setSigModal(null)}
          onApply={(v) => { setFieldValue(sigModal.id, v); setSigModal(null); advanceToNext(sigModal.id); }}
        />
      )}

      {/* SIGNATURE / INITIALS MODAL */}
      {sigModal && (sigModal.field_type === 'signature' || sigModal.field_type === 'initials') && (
        <SigModal
          field={sigModal} sigMode={sigMode} setSigMode={(m) => { setSigMode(m); setError(''); }}
          typedSig={typedSig} setTypedSig={setTypedSig} sigFont={sigFont} setSigFont={setSigFont}
          sigCanvasRef={sigCanvasRef} fonts={fonts} error={error}
          onCancel={() => { setSigModal(null); setError(''); }} onApply={applySigModal}
        />
      )}

      {/* LEGACY SIGNATURE MODAL */}
      {legacyModal && (
        <SigModal
          field={{ field_type: 'signature', id: '__legacy__' }}
          sigMode={sigMode} setSigMode={(m) => { setSigMode(m); setError(''); }}
          typedSig={typedSig} setTypedSig={setTypedSig} sigFont={sigFont} setSigFont={setSigFont}
          sigCanvasRef={sigCanvasRef} fonts={fonts} error={error}
          onCancel={() => { setLegacyModal(false); setError(''); }} onApply={handleLegacyApply}
        />
      )}

      <link rel="preconnect" href="https://fonts.googleapis.com" />
      <link href="https://fonts.googleapis.com/css2?family=Dancing+Script:wght@700&family=Pacifico&family=Great+Vibes&family=Caveat:wght@700&display=swap" rel="stylesheet" />
      <style>{`@keyframes spin { to { transform: rotate(360deg); } } @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.55} }`}</style>
    </div>
  );
}

// ── FIELD OVERLAY ─────────────────────────────────────────────────────────────
function FieldOverlay({ field, filled, value, isActive, isMissing, fieldRef, onClick }) {
  let bg, border, shadow;
  if (isMissing) {
    bg = 'rgba(220,38,38,0.15)'; border = '2px dashed #dc2626'; shadow = '0 0 0 3px rgba(220,38,38,0.2)';
  } else if (filled) {
    bg = 'rgba(22,163,74,0.12)'; border = '2px solid #16a34a'; shadow = 'none';
  } else if (isActive) {
    bg = 'rgba(37,99,235,0.15)'; border = '2.5px solid #2563eb'; shadow = '0 0 0 3px rgba(37,99,235,0.25)';
  } else {
    bg = 'rgba(245,158,11,0.18)'; border = '2px dashed #f59e0b'; shadow = 'none';
  }
  const labelColor = isMissing ? '#dc2626' : filled ? '#16a34a' : isActive ? '#2563eb' : '#f59e0b';

  const content = (() => {
    if (!filled) {
      return (
        <span style={{ fontSize: '0.7rem', fontWeight: 700, color: labelColor, pointerEvents: 'none', textAlign: 'center', lineHeight: 1.2, padding: '0 2px' }}>
          {FIELD_ICONS[field.field_type]} {isMissing ? '⚠️ Required' : FIELD_LABELS[field.field_type]}{field.required && !isMissing ? ' *' : ''}
        </span>
      );
    }
    if (field.field_type === 'signature' || field.field_type === 'initials') {
      return <img src={value} alt="" style={{ maxWidth: '95%', maxHeight: '95%', objectFit: 'contain', pointerEvents: 'none' }} />;
    }
    if (field.field_type === 'checkbox') {
      return <span style={{ fontSize: '1.1rem', pointerEvents: 'none' }}>{value === 'true' ? '☑' : '☐'}</span>;
    }
    if (field.field_type === 'date') {
      return <span style={{ fontSize: '0.75rem', color: '#0f172a', pointerEvents: 'none' }}>{(value || new Date().toISOString()).slice(0, 10)}</span>;
    }
    if (field.field_type === 'text') {
      return <span style={{ fontSize: '0.75rem', color: '#0f172a', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', pointerEvents: 'none', padding: '0 4px' }}>{value}</span>;
    }
    return null;
  })();

  return (
    <div
      ref={fieldRef}
      onClick={onClick}
      style={{
        position: 'absolute',
        left:   `${field.x_pct}%`,
        top:    `${field.y_pct}%`,
        width:  `${field.width_pct}%`,
        height: `${field.height_pct}%`,
        background: bg, border, boxShadow: shadow,
        borderRadius: 3,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        cursor: 'pointer', boxSizing: 'border-box', overflow: 'hidden',
        animation: isActive && !filled ? 'pulse 1.6s ease-in-out infinite' : 'none',
        transition: 'border-color 0.2s, box-shadow 0.2s, background 0.2s',
      }}
    >
      {content}
    </div>
  );
}

// ── SIGNATURE MODAL ───────────────────────────────────────────────────────────
function SigModal({ field, sigMode, setSigMode, typedSig, setTypedSig, sigFont, setSigFont, sigCanvasRef, fonts, error, onCancel, onApply }) {
  const isLegacy = field.id === '__legacy__';
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.65)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100, padding: '1rem' }}>
      <div style={{ background: 'white', borderRadius: 16, width: '100%', maxWidth: 520, boxShadow: '0 24px 64px rgba(0,0,0,0.3)', overflow: 'hidden' }}>
        <div style={{ padding: '1.25rem 1.5rem 0', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <div>
            <div style={{ fontSize: '1.1rem', fontWeight: 700, color: '#0f172a' }}>
              {isLegacy ? 'Add Your Signature' : `Add Your ${FIELD_LABELS[field.field_type]}`}
            </div>
            <div style={{ fontSize: '0.78rem', color: '#64748b', marginTop: 2 }}>Draw or type below</div>
          </div>
          <button onClick={onCancel} style={{ background: '#f1f5f9', border: 'none', width: 32, height: 32, borderRadius: '50%', cursor: 'pointer', fontSize: '0.9rem', color: '#64748b', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>✕</button>
        </div>
        <div style={{ display: 'flex', gap: 4, padding: '0.75rem 1.5rem 0', borderBottom: '1px solid #f1f5f9' }}>
          {[{ id: 'draw', label: '✏️ Draw' }, { id: 'type', label: '⌨️ Type' }].map(m => (
            <button key={m.id} onClick={() => setSigMode(m.id)}
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
              <button onClick={() => sigCanvasRef.current?.clear()}
                style={{ padding: '0.3rem 0.75rem', background: '#f1f5f9', border: '1px solid #e2e8f0', borderRadius: 6, cursor: 'pointer', fontSize: '0.78rem', color: '#374151' }}>
                Clear
              </button>
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
        {error && (
          <div style={{ margin: '0 1.5rem', padding: '0.6rem 0.9rem', background: '#fee2e2', color: '#dc2626', borderRadius: 6, fontSize: '0.8rem' }}>
            {error}
          </div>
        )}
        <div style={{ padding: '1rem 1.5rem 1.5rem', display: 'flex', gap: '0.75rem', justifyContent: 'flex-end', borderTop: '1px solid #f1f5f9', marginTop: '0.75rem' }}>
          <button onClick={onCancel} style={{ padding: '0.7rem 1.25rem', background: '#f1f5f9', color: '#374151', border: 'none', borderRadius: 8, fontWeight: 600, fontSize: '0.9rem', cursor: 'pointer' }}>Cancel</button>
          <button onClick={onApply} style={{ padding: '0.7rem 1.5rem', background: '#2563eb', color: 'white', border: 'none', borderRadius: 8, fontWeight: 700, fontSize: '0.9rem', cursor: 'pointer' }}>Apply →</button>
        </div>
      </div>
    </div>
  );
}

// ── TEXT FIELD MODAL ──────────────────────────────────────────────────────────
function TextFieldModal({ field, initial, onCancel, onApply }) {
  const [v, setV] = useState(initial);
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.65)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100, padding: '1rem' }}>
      <div style={{ background: 'white', borderRadius: 16, width: '100%', maxWidth: 460, boxShadow: '0 24px 64px rgba(0,0,0,0.3)', overflow: 'hidden' }}>
        <div style={{ padding: '1.25rem 1.5rem', borderBottom: '1px solid #f1f5f9' }}>
          <div style={{ fontSize: '1.05rem', fontWeight: 700, color: '#0f172a' }}>{field.label || 'Enter text'}</div>
        </div>
        <div style={{ padding: '1.25rem 1.5rem' }}>
          <textarea value={v} onChange={e => setV(e.target.value.slice(0, 500))} placeholder="Type here…" autoFocus
            style={{ width: '100%', minHeight: 90, padding: '0.75rem', border: '1.5px solid #e2e8f0', borderRadius: 8, fontSize: '0.9rem', outline: 'none', resize: 'vertical', boxSizing: 'border-box' }} />
          <div style={{ textAlign: 'right', fontSize: '0.7rem', color: '#94a3b8', marginTop: 4 }}>{v.length} / 500</div>
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
  successCard: { textAlign: 'center', background: 'white', borderRadius: 20, padding: '2.5rem 2rem', boxShadow: '0 8px 40px rgba(0,0,0,0.10)', maxWidth: 420, width: '100%' },
  btnPrimary: { padding: '0.8rem 2.25rem', background: '#2563eb', color: 'white', border: 'none', borderRadius: 10, fontWeight: 700, fontSize: '0.95rem', cursor: 'pointer', display: 'inline-block' },
  spinner:   { width: 40, height: 40, border: '3px solid #e5e7eb', borderTopColor: '#2563eb', borderRadius: '50%', animation: 'spin 0.8s linear infinite', margin: '0 auto' },
  spinnerSm: { width: 16, height: 16, border: '2px solid #bfdbfe', borderTopColor: '#2563eb', borderRadius: '50%', animation: 'spin 0.8s linear infinite', flexShrink: 0 },
};
