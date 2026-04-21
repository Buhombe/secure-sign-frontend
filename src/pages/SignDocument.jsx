import { useEffect, useRef, useState, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import SignatureCanvas from 'react-signature-canvas';

const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:5000/api';

export default function SignDocument() {
  const { id }      = useParams();
  const navigate    = useNavigate();

  const [recipientToken] = useState(() => {
    const hash = window.location.hash;
    if (!hash.startsWith('#token=')) return null;
    const raw = decodeURIComponent(hash.slice('#token='.length));
    window.history.replaceState(null, '', window.location.pathname + window.location.search);
    return raw || null;
  });

  const [pdfUrl,    setPdfUrl]    = useState('');
  const [loading,   setLoading]   = useState(true);
  const [error,     setError]     = useState('');
  const [done,      setDone]      = useState(false);
  const [saving,    setSaving]    = useState(false);
  const [showModal, setShowModal] = useState(false);
  const [sigMode,   setSigMode]   = useState('draw');
  const [typedSig,  setTypedSig]  = useState('');
  const [sigFont,   setSigFont]   = useState('Dancing Script');

  const sigCanvasRef = useRef();

  useEffect(() => {
    const load = async () => {
      try {
        const token = localStorage.getItem('token');
        const url   = recipientToken
          ? `${API_BASE}/documents/${id}/serve/public?token=${recipientToken}`
          : `${API_BASE}/documents/${id}/serve`;
        const headers = {};
        if (token && !recipientToken) headers['Authorization'] = `Bearer ${token}`;
        const r = await fetch(url, { headers });
        if (!r.ok) throw new Error('Failed to fetch PDF');
        const blob = new Blob([await r.arrayBuffer()], { type: 'application/pdf' });
        setPdfUrl(URL.createObjectURL(blob));
      } catch (e) {
        setError('Could not load document. The signing link may have expired.');
      } finally {
        setLoading(false);
      }
    };
    load();
  }, [id]);

  const renderTypedSig = useCallback(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 440; canvas.height = 120;
    const ctx = canvas.getContext('2d');
    ctx.font = `64px '${sigFont}', cursive`;
    ctx.fillStyle = '#1e293b';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(typedSig || 'Your Name', 220, 65);
    return canvas.toDataURL('image/png');
  }, [typedSig, sigFont]);

  const handleApply = () => {
    let img = null;
    if (sigMode === 'draw') {
      if (!sigCanvasRef.current || sigCanvasRef.current.isEmpty()) {
        setError('Please draw your signature.'); return;
      }
      img = sigCanvasRef.current.getCanvas().toDataURL('image/png');
    } else {
      if (!typedSig.trim()) { setError('Please type your name.'); return; }
      img = renderTypedSig();
    }
    setError('');
    setShowModal(false);
    handleSign(img);
  };

  const handleSign = async (img) => {
    setSaving(true);
    setError('');
    try {
      const token = localStorage.getItem('token');
      let response;
      if (recipientToken) {
        response = await fetch(`${API_BASE}/signers/${id}/sign-public`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: recipientToken, signatureData: img, sigX: 10, sigY: 80, sigWidth: 220, sigHeight: 70, pageNumber: 1 }),
        });
      } else if (token) {
        response = await fetch(`${API_BASE}/signers/${id}/sign`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
          body: JSON.stringify({ signatureData: img, sigX: 10, sigY: 80, sigWidth: 220, sigHeight: 70, pageNumber: 1 }),
        });
      } else {
        setError('You must be signed in or use a valid signing link.');
        setSaving(false);
        return;
      }
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Signing failed.');
      setDone(true);
    } catch (e) {
      setError(e.message || 'Signing failed. Please try again.');
    } finally {
      setSaving(false);
    }
  };

  if (done) return (
    <div style={s.page}>
      <div style={s.successCard}>
        <div style={{ fontSize: '3.5rem', marginBottom: '1rem' }}>✅</div>
        <h2 style={{ fontSize: '1.4rem', fontWeight: 700, color: '#0f172a', marginBottom: '0.5rem' }}>Document Signed!</h2>
        <p style={{ color: '#64748b', marginBottom: '1.5rem' }}>Your signature has been applied and recorded securely.</p>
        <button onClick={() => navigate(recipientToken ? '/login' : '/dashboard')} style={s.btnPrimary}>
          {recipientToken ? 'Done' : 'Go to Dashboard'}
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

  if (error && !pdfUrl) return (
    <div style={s.page}>
      <div style={{ textAlign: 'center', background: 'white', borderRadius: 16, padding: '2rem', maxWidth: 380 }}>
        <div style={{ fontSize: '2.5rem', marginBottom: '0.75rem' }}>⚠️</div>
        <p style={{ color: '#dc2626', fontWeight: 600 }}>{error}</p>
      </div>
    </div>
  );

  const fonts = ['Dancing Script', 'Pacifico', 'Great Vibes', 'Caveat'];

  return (
    <div style={{ minHeight: '100vh', background: '#475569', display: 'flex', flexDirection: 'column' }}>

      {/* Top bar */}
      <div style={{ background: '#1a3a5c', padding: '0.75rem 1.5rem', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '0.5rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <div style={{ width: 36, height: 36, background: 'rgba(255,255,255,0.15)', borderRadius: 8, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '1.1rem' }}>✍️</div>
          <div>
            <div style={{ color: 'white', fontWeight: 800, fontSize: '1rem' }}>SecureSign</div>
            <div style={{ color: 'rgba(255,255,255,0.5)', fontSize: '0.7rem' }}>Document Signing</div>
          </div>
        </div>
        <div style={{ color: 'rgba(255,255,255,0.7)', fontSize: '0.8rem' }}>
          🔒 Secured with cryptographic signature
        </div>
      </div>

      {/* Info bar */}
      {!saving && !error && (
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

      {/* PDF */}
      <div style={{ flex: 1, overflow: 'auto', display: 'flex', justifyContent: 'center', padding: '1rem' }}>
        <iframe src={pdfUrl} style={{ width: '100%', maxWidth: 860, height: 'calc(100vh - 200px)', minHeight: 400, border: 'none', borderRadius: 4, background: 'white', display: 'block' }} title="Document" />
      </div>

      {/* Bottom action bar */}
      <div style={{ background: 'white', borderTop: '2px solid #e5e7eb', padding: '1rem 1.5rem', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '1.5rem', flexWrap: 'wrap' }}>
        <button onClick={() => { setError(''); setShowModal(true); }} disabled={saving}
          style={{ padding: '0.9rem 2.5rem', background: '#f59e0b', color: 'white', border: 'none', borderRadius: 8, fontWeight: 800, fontSize: '1rem', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '0.6rem', boxShadow: '0 4px 12px rgba(245,158,11,0.35)' }}>
          ✍️ Sign Document
        </button>
      </div>

      {/* Signature Modal */}
      {showModal && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100, padding: '1rem' }}>
          <div style={{ background: 'white', borderRadius: 16, width: '100%', maxWidth: 520, boxShadow: '0 24px 64px rgba(0,0,0,0.3)', overflow: 'hidden' }}>

            <div style={{ padding: '1.5rem 1.5rem 0', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
              <div>
                <div style={{ fontSize: '1.1rem', fontWeight: 700, color: '#0f172a' }}>Add Your Signature</div>
                <div style={{ fontSize: '0.8rem', color: '#64748b', marginTop: 2 }}>Draw or type your signature below</div>
              </div>
              <button onClick={() => setShowModal(false)} style={{ background: '#f1f5f9', border: 'none', width: 32, height: 32, borderRadius: '50%', cursor: 'pointer', fontSize: '0.9rem', color: '#64748b' }}>✕</button>
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
              <button onClick={() => setShowModal(false)} style={{ padding: '0.7rem 1.25rem', background: '#f1f5f9', color: '#374151', border: 'none', borderRadius: 8, fontWeight: 600, fontSize: '0.9rem', cursor: 'pointer' }}>Cancel</button>
              <button onClick={handleApply} style={{ padding: '0.7rem 1.5rem', background: '#2563eb', color: 'white', border: 'none', borderRadius: 8, fontWeight: 700, fontSize: '0.9rem', cursor: 'pointer' }}>
                Apply Signature →
              </button>
            </div>
          </div>
        </div>
      )}

      <link rel="preconnect" href="https://fonts.googleapis.com" />
      <link href="https://fonts.googleapis.com/css2?family=Dancing+Script:wght@700&family=Pacifico&family=Great+Vibes&family=Caveat:wght@700&display=swap" rel="stylesheet" />
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
