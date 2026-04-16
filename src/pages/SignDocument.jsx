import { useEffect, useRef, useState, useCallback } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import SignatureCanvas from 'react-signature-canvas';
import api from '../services/api';

const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:5000/api';

export default function SignDocument() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const recipientToken = searchParams.get('token');

  const [doc, setDoc] = useState(null);
  const [loading, setLoading] = useState(true);
  const [step, setStep] = useState(1);
  const [sigMode, setSigMode] = useState('draw');
  const [typedSig, setTypedSig] = useState('');
  const [sigFont, setSigFont] = useState('Dancing Script');
  const [sigImage, setSigImage] = useState(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const [pdfUrl, setPdfUrl] = useState('');
  const [sigPos, setSigPos] = useState({ x: 50, y: 70, w: 220, h: 80 });
  const [dragging, setDragging] = useState(false);
  const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 });

  const sigCanvasRef = useRef();
  const pdfContainerRef = useRef();
  const sigBoxRef = useRef();

  // ── Load document + PDF ───────────────────────────────────────────────────
  useEffect(() => {
    const load = async () => {
      try {
        // Fetch document metadata
        const config = recipientToken ? { params: { token: recipientToken } } : {};
        const { data } = await api.get(`/documents/${id}`, config);
        setDoc(data.document);

        // Fetch PDF — backend now redirects to Cloudinary URL
        // Use { redirect: 'follow' } so fetch follows the 302 redirect
        const token = localStorage.getItem('token');
        const url = recipientToken
          ? `${API_BASE}/documents/${id}/serve/public?token=${recipientToken}`
          : `${API_BASE}/documents/${id}/serve`;

        const headers = {};
        if (token && !recipientToken) headers['Authorization'] = `Bearer ${token}`;

        const r = await fetch(url, { headers });
        if (!r.ok) throw new Error('Failed to fetch PDF');
        const arrayBuffer = await r.arrayBuffer();
        const blob = new Blob([arrayBuffer], { type: 'application/pdf' });
        setPdfUrl(URL.createObjectURL(blob));
      } catch (e) {
        console.error(e);
        setError('Could not load document.');
      } finally {
        setLoading(false);
      }
    };
    load();
  }, [id]);

  // ── Typed signature renderer ──────────────────────────────────────────────
  const renderTypedSig = useCallback(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 440; canvas.height = 120;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, 440, 120);
    ctx.font = `64px '${sigFont}', cursive`;
    ctx.fillStyle = '#1e293b';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(typedSig || 'Your Name', 220, 65);
    return canvas.toDataURL('image/png');
  }, [typedSig, sigFont]);

  const handleStep1Next = () => {
    let img = null;
    if (sigMode === 'draw') {
      if (!sigCanvasRef.current || sigCanvasRef.current.isEmpty()) {
        setError('Please draw your signature.'); return;
      }
      img = sigCanvasRef.current.getCanvas().toDataURL('image/png');
    } else {
      if (!typedSig.trim()) { setError('Please enter your name.'); return; }
      img = renderTypedSig();
    }
    setError('');
    setSigImage(img);
    setStep(2);
  };

  // ── Drag handlers ─────────────────────────────────────────────────────────
  const handleMouseDown = (e) => {
    e.preventDefault();
    const rect = sigBoxRef.current.getBoundingClientRect();
    setDragOffset({ x: e.clientX - rect.left, y: e.clientY - rect.top });
    setDragging(true);
  };

  const handleTouchStart = (e) => {
    const touch = e.touches[0];
    const rect = sigBoxRef.current.getBoundingClientRect();
    setDragOffset({ x: touch.clientX - rect.left, y: touch.clientY - rect.top });
    setDragging(true);
  };

  useEffect(() => {
    if (!dragging) return;
    const move = (e) => {
      const clientX = e.touches ? e.touches[0].clientX : e.clientX;
      const clientY = e.touches ? e.touches[0].clientY : e.clientY;
      const container = pdfContainerRef.current;
      if (!container) return;
      const rect = container.getBoundingClientRect();
      let nx = clientX - rect.left - dragOffset.x;
      let ny = clientY - rect.top - dragOffset.y;
      nx = Math.max(0, Math.min(nx, rect.width - sigPos.w));
      ny = Math.max(0, Math.min(ny, rect.height - sigPos.h));
      setSigPos(p => ({ ...p, x: nx, y: ny }));
    };
    const up = () => setDragging(false);
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    window.addEventListener('touchmove', move, { passive: false });
    window.addEventListener('touchend', up);
    return () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      window.removeEventListener('touchmove', move);
      window.removeEventListener('touchend', up);
    };
  }, [dragging, dragOffset, sigPos.w, sigPos.h]);

  // ── Submit signature ──────────────────────────────────────────────────────
  const handleConfirmSign = async () => {
    setSaving(true);
    setError('');
    try {
      const container = pdfContainerRef.current;
      const cw = container?.offsetWidth || 600;
      const ch = container?.offsetHeight || 800;
      const xPct = (sigPos.x / cw) * 100;
      const yPct = (sigPos.y / ch) * 100;

      // Get signer email — from URL param or logged in user
      const urlParams = new URLSearchParams(window.location.search);
      const signerEmailFromUrl = urlParams.get('signer');
      const loggedInUser = localStorage.getItem('user') 
        ? JSON.parse(localStorage.getItem('user')).email 
        : null;
      const signerEmail = signerEmailFromUrl || loggedInUser || '';

      if (!signerEmail) {
        setError('Could not determine signer email.');
        setSaving(false);
        return;
      }

      // Use public endpoint (no auth required)
      const response = await fetch(`${API_BASE}/signers/${id}/sign-public`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          signatureData: sigImage,
          sigX: xPct,
          sigY: yPct,
          sigWidth: sigPos.w,
          sigHeight: sigPos.h,
          pageNumber: 1,
          signerEmail,
        }),
      });

      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Signing failed.');

      setStep(4);
    } catch (e) {
      setError(e.response?.data?.error || 'Signing failed. Please try again.');
    } finally {
      setSaving(false);
    }
  };

  // ── Render ────────────────────────────────────────────────────────────────
  if (loading) return <div style={s.center}>Loading document...</div>;
  if (error && !doc) return <div style={s.center}>{error}</div>;

  if (step === 4) return (
    <div style={s.center}>
      <div style={{ textAlign: 'center', maxWidth: 400 }}>
        <div style={{ fontSize: '4rem', marginBottom: '1rem' }}>🎉</div>
        <h2 style={{ fontSize: '1.4rem', fontWeight: 700, color: '#0f172a', marginBottom: '0.5rem' }}>Document Signed!</h2>
        <p style={{ color: '#64748b', marginBottom: '1.5rem' }}>{doc?.original_name} has been signed successfully.</p>
        <button onClick={() => navigate(recipientToken ? '/login' : '/dashboard')}
          style={{ padding: '0.75rem 1.5rem', background: '#2563eb', color: 'white', border: 'none', borderRadius: 8, cursor: 'pointer', fontWeight: 700, fontSize: '1rem' }}>
          {recipientToken ? 'Done' : 'Back to Dashboard'}
        </button>
      </div>
    </div>
  );

  const fonts = ['Dancing Script', 'Pacifico', 'Great Vibes', 'Caveat'];

  return (
    <div style={{ minHeight: '100vh', background: '#f8fafc', display: 'flex', flexDirection: 'column' }}>
      {/* Top bar */}
      <div style={{ background: 'white', borderBottom: '1px solid #e5e7eb', padding: '0.75rem 1.5rem', display: 'flex', alignItems: 'center', gap: '1rem', flexWrap: 'wrap' }}>
        {step > 1 && (
          <button onClick={() => setStep(step - 1)}
            style={{ padding: '0.4rem 0.9rem', background: '#f1f5f9', border: 'none', borderRadius: 7, cursor: 'pointer', fontWeight: 600, fontSize: '0.875rem' }}>
            ← Back
          </button>
        )}
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 700, color: '#0f172a', fontSize: '0.95rem' }}>📄 {doc?.original_name}</div>
        </div>
        {/* Step indicator */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          {['Create Signature', 'Place Signature', 'Confirm'].map((label, i) => (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
              <div style={{
                width: 24, height: 24, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center',
                background: step > i + 1 ? '#16a34a' : step === i + 1 ? '#2563eb' : '#e5e7eb',
                color: step >= i + 1 ? 'white' : '#94a3b8', fontSize: '0.72rem', fontWeight: 700,
              }}>{step > i + 1 ? '✓' : i + 1}</div>
              {i < 2 && <div style={{ width: 24, height: 1, background: '#e5e7eb' }} />}
            </div>
          ))}
        </div>
      </div>

      {error && (
        <div style={{ background: '#fee2e2', color: '#dc2626', padding: '0.75rem 1.5rem', fontSize: '0.875rem', textAlign: 'center' }}>
          {error}
        </div>
      )}

      {/* STEP 1 — Create signature */}
      {step === 1 && (
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '2rem 1rem' }}>
          <div style={{ background: 'white', borderRadius: 16, border: '1px solid #e5e7eb', padding: '2rem', width: '100%', maxWidth: 540, boxShadow: '0 4px 24px rgba(0,0,0,0.08)' }}>
            <h2 style={{ fontSize: '1.1rem', fontWeight: 700, color: '#0f172a', marginBottom: '0.25rem' }}>Create Your Signature</h2>
            <p style={{ fontSize: '0.8rem', color: '#64748b', marginBottom: '1.5rem' }}>Choose how you'd like to sign</p>

            {/* Mode tabs */}
            <div style={{ display: 'flex', background: '#f1f5f9', borderRadius: 9, padding: 3, marginBottom: '1.5rem', gap: 3 }}>
              {[{ id: 'draw', label: '✏️ Draw' }, { id: 'type', label: '⌨️ Type' }, { id: 'style', label: '🎨 Style' }].map(m => (
                <button key={m.id} onClick={() => { setSigMode(m.id); setError(''); }}
                  style={{ flex: 1, padding: '0.5rem', border: 'none', borderRadius: 7, background: sigMode === m.id ? 'white' : 'transparent', color: sigMode === m.id ? '#2563eb' : '#64748b', fontWeight: sigMode === m.id ? 700 : 500, fontSize: '0.85rem', cursor: 'pointer', boxShadow: sigMode === m.id ? '0 1px 3px rgba(0,0,0,0.1)' : 'none' }}>
                  {m.label}
                </button>
              ))}
            </div>

            {sigMode === 'draw' && (
              <div>
                <div style={{ border: '1.5px solid #e2e8f0', borderRadius: 10, background: '#fafafa', overflow: 'hidden', marginBottom: '0.75rem' }}>
                  <SignatureCanvas ref={sigCanvasRef} penColor="#1e293b"
                    canvasProps={{ style: { width: '100%', height: 160, display: 'block', touchAction: 'none' } }} />
                  <div style={{ borderTop: '1px dashed #e2e8f0', textAlign: 'center', padding: '0.35rem', fontSize: '0.7rem', color: '#94a3b8' }}>
                    Sign here with your mouse or finger
                  </div>
                </div>
                <button onClick={() => sigCanvasRef.current?.clear()}
                  style={{ padding: '0.35rem 0.75rem', background: '#f1f5f9', border: '1px solid #e5e7eb', borderRadius: 7, cursor: 'pointer', fontSize: '0.8rem', color: '#374151' }}>
                  Clear
                </button>
              </div>
            )}

            {sigMode === 'type' && (
              <div>
                <input value={typedSig} onChange={e => setTypedSig(e.target.value)} placeholder="Type your full name"
                  style={{ width: '100%', padding: '0.75rem', border: '1.5px solid #e2e8f0', borderRadius: 8, fontSize: '0.9rem', outline: 'none', marginBottom: '1rem' }} />
                <div style={{ border: '1.5px solid #e2e8f0', borderRadius: 10, background: '#fafafa', padding: '1rem', textAlign: 'center', marginBottom: '0.75rem', minHeight: 80, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <span style={{ fontFamily: `'${sigFont}', cursive`, fontSize: '2.5rem', color: '#1e293b' }}>{typedSig || 'Your Name'}</span>
                </div>
              </div>
            )}

            {sigMode === 'style' && (
              <div>
                <input value={typedSig} onChange={e => setTypedSig(e.target.value)} placeholder="Type your full name"
                  style={{ width: '100%', padding: '0.75rem', border: '1.5px solid #e2e8f0', borderRadius: 8, fontSize: '0.9rem', outline: 'none', marginBottom: '1rem' }} />
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.6rem' }}>
                  {fonts.map(f => (
                    <div key={f} onClick={() => { setSigFont(f); setSigMode('type'); }}
                      style={{ border: `2px solid ${sigFont === f ? '#2563eb' : '#e2e8f0'}`, borderRadius: 8, padding: '0.75rem', background: sigFont === f ? '#eff6ff' : '#fafafa', cursor: 'pointer', textAlign: 'center' }}>
                      <span style={{ fontFamily: `'${f}', cursive`, fontSize: '1.5rem', color: '#1e293b' }}>{typedSig || 'Signature'}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <button onClick={handleStep1Next}
              style={{ width: '100%', marginTop: '1.5rem', padding: '0.75rem', background: '#2563eb', color: 'white', border: 'none', borderRadius: 9, fontWeight: 700, fontSize: '0.95rem', cursor: 'pointer' }}>
              Continue — Place Signature →
            </button>
          </div>
        </div>
      )}

      {/* STEP 2 — Place signature on PDF */}
      {step === 2 && (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
          <div style={{ background: '#1e293b', color: '#94a3b8', padding: '0.6rem 1.5rem', fontSize: '0.8rem', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '0.5rem' }}>
            <span>📍 Drag the signature box to where you want it on the document</span>
            <button onClick={() => setStep(3)}
              style={{ padding: '0.4rem 1rem', background: '#2563eb', color: 'white', border: 'none', borderRadius: 7, fontWeight: 700, fontSize: '0.8rem', cursor: 'pointer' }}>
              Confirm Placement →
            </button>
          </div>
          <div style={{ flex: 1, overflow: 'auto', display: 'flex', justifyContent: 'center', alignItems: 'flex-start', padding: '0.75rem', background: '#334155' }}>
            <div ref={pdfContainerRef} style={{ position: 'relative', display: 'inline-block', width: '100%', maxWidth: 700, userSelect: 'none' }}>
              <iframe src={pdfUrl} style={{ width: '100%', height: '75vh', minHeight: 400, border: 'none', display: 'block', borderRadius: 4 }} title="PDF" />
              <div ref={sigBoxRef} onMouseDown={handleMouseDown} onTouchStart={handleTouchStart}
                style={{ position: 'absolute', left: sigPos.x, top: sigPos.y, width: sigPos.w, height: sigPos.h, border: '2px dashed #2563eb', borderRadius: 6, background: 'rgba(239,246,255,0.9)', cursor: dragging ? 'grabbing' : 'grab', display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: '0 4px 16px rgba(37,99,235,0.25)', zIndex: 10, touchAction: 'none' }}>
                <img src={sigImage} alt="sig" style={{ maxWidth: '90%', maxHeight: '85%', objectFit: 'contain' }} />
                <div style={{ position: 'absolute', top: -20, left: 0, fontSize: '0.65rem', color: '#2563eb', fontWeight: 600, whiteSpace: 'nowrap', background: 'white', padding: '1px 6px', borderRadius: 4, border: '1px solid #bfdbfe' }}>
                  ✥ Drag to reposition
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* STEP 3 — Confirm */}
      {step === 3 && !saving && (
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '2rem 1rem' }}>
          <div style={{ background: 'white', borderRadius: 16, border: '1px solid #e5e7eb', padding: '2rem', width: '100%', maxWidth: 440, boxShadow: '0 4px 24px rgba(0,0,0,0.08)', textAlign: 'center' }}>
            <div style={{ fontSize: '3rem', marginBottom: '0.75rem' }}>🔐</div>
            <h2 style={{ fontSize: '1.1rem', fontWeight: 700, color: '#0f172a', marginBottom: '0.5rem' }}>Confirm & Sign</h2>
            <p style={{ fontSize: '0.85rem', color: '#64748b', marginBottom: '1.5rem', lineHeight: 1.6 }}>
              By clicking Confirm, you agree this digital signature is legally binding.
            </p>
            <div style={{ border: '1.5px solid #e2e8f0', borderRadius: 10, padding: '1rem', marginBottom: '1.25rem', background: '#f8fafc' }}>
              <img src={sigImage} alt="signature" style={{ maxWidth: 240, maxHeight: 80, objectFit: 'contain' }} />
            </div>
            <div style={{ background: '#f8fafc', borderRadius: 8, padding: '0.9rem', marginBottom: '1.5rem', textAlign: 'left', fontSize: '0.8rem', color: '#374151', display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
              <div>📄 {doc?.original_name}</div>
              <div>🕐 {new Date().toLocaleString()}</div>
              <div>✅ Device verified</div>
            </div>
            <div style={{ display: 'flex', gap: '0.75rem' }}>
              <button onClick={() => setStep(2)}
                style={{ flex: 1, padding: '0.7rem', background: '#f1f5f9', border: 'none', borderRadius: 8, cursor: 'pointer', fontWeight: 600, fontSize: '0.875rem' }}>
                ← Edit
              </button>
              <button onClick={handleConfirmSign}
                style={{ flex: 2, padding: '0.7rem', background: '#2563eb', color: 'white', border: 'none', borderRadius: 8, cursor: 'pointer', fontWeight: 700, fontSize: '0.875rem' }}>
                ✅ Confirm & Sign
              </button>
            </div>
          </div>
        </div>
      )}

      {saving && (
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ textAlign: 'center' }}>
            <div style={{ fontSize: '2.5rem', marginBottom: '1rem' }}>⏳</div>
            <div style={{ color: '#64748b', fontWeight: 600 }}>Signing document...</div>
          </div>
        </div>
      )}

      <link rel="preconnect" href="https://fonts.googleapis.com" />
      <link href="https://fonts.googleapis.com/css2?family=Dancing+Script:wght@700&family=Pacifico&family=Great+Vibes&family=Caveat:wght@700&display=swap" rel="stylesheet" />
    </div>
  );
}

const s = {
  center: { display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '100vh', color: '#64748b', fontSize: '1rem' },
};