import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../services/api';
import AppShell from '../components/AppShell';

export default function Upload() {
  const [file, setFile] = useState(null);
  const [dragging, setDragging] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [signers, setSigners] = useState(['']);
  const navigate = useNavigate();

  const handleFile = (f) => {
    if (f?.type === 'application/pdf') { setFile(f); setError(''); }
    else setError('Please select a PDF file only.');
  };

  const addSigner = () => {
    if (signers.length < 10) setSigners([...signers, '']);
  };

  const removeSigner = (index) => {
    setSigners(signers.filter((_, i) => i !== index));
  };

  const updateSigner = (index, value) => {
    const updated = [...signers];
    updated[index] = value;
    setSigners(updated);
  };

  const handleUpload = async () => {
    if (!file) return setError('Please select a PDF first.');
    setLoading(true); setError('');
    try {
      // Upload document
      const form = new FormData();
      form.append('pdf', file);
      const { data } = await api.post('/documents/upload', form, {
        headers: { 'Content-Type': 'multipart/form-data' }
      });

      const documentId = data.document.id;

      // Add signers if any
      const validSigners = signers.filter(s => s.trim() !== '');
      if (validSigners.length > 0) {
        await api.post(`/signers/${documentId}/add`, { signers: validSigners });
      }

      navigate('/dashboard');
    } catch (e) {
      setError(e.response?.data?.error || 'Upload failed.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <AppShell>
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '2rem 1rem' }}>
        <div style={{ background: 'white', borderRadius: 16, border: '1px solid #e5e7eb', padding: 'clamp(1.5rem, 4vw, 2.5rem)', width: '100%', maxWidth: 520, boxShadow: '0 4px 24px rgba(0,0,0,0.06)' }}>
          <h2 style={{ fontSize: '1.2rem', fontWeight: 700, color: '#0f172a', marginBottom: '0.25rem' }}>Upload Document</h2>
          <p style={{ color: '#64748b', fontSize: '0.85rem', marginBottom: '1.5rem' }}>Upload a PDF and add signers in order</p>

          {error && <div style={{ background: '#fee2e2', color: '#dc2626', padding: '0.7rem', borderRadius: 8, marginBottom: '1rem', fontSize: '0.85rem' }}>{error}</div>}

          {/* Drop zone */}
          <div
            onClick={() => document.getElementById('fileInput').click()}
            onDragOver={e => { e.preventDefault(); setDragging(true); }}
            onDragLeave={() => setDragging(false)}
            onDrop={e => { e.preventDefault(); setDragging(false); handleFile(e.dataTransfer.files[0]); }}
            style={{ border: `2px dashed ${dragging ? '#2563eb' : '#e2e8f0'}`, borderRadius: 12, padding: '2rem', textAlign: 'center', cursor: 'pointer', background: dragging ? '#eff6ff' : '#f8fafc', marginBottom: '1.25rem', transition: 'all 0.15s' }}>
            <div style={{ fontSize: '2.5rem', marginBottom: '0.5rem' }}>{file ? '📄' : '📂'}</div>
            {file ? (
              <>
                <div style={{ fontWeight: 700, color: '#0f172a', marginBottom: '0.25rem' }}>{file.name}</div>
                <div style={{ fontSize: '0.8rem', color: '#64748b' }}>{(file.size / 1024 / 1024).toFixed(2)} MB</div>
              </>
            ) : (
              <>
                <div style={{ fontWeight: 600, color: '#374151', marginBottom: '0.25rem' }}>Drag & drop your PDF here</div>
                <div style={{ fontSize: '0.8rem', color: '#94a3b8' }}>or click to browse — max 10MB</div>
              </>
            )}
          </div>
          <input id="fileInput" type="file" accept="application/pdf" onChange={e => handleFile(e.target.files[0])} style={{ display: 'none' }} />

          {/* Signers */}
          <div style={{ marginBottom: '1.25rem' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.75rem' }}>
              <label style={{ fontSize: '0.85rem', fontWeight: 700, color: '#374151' }}>
                Signers <span style={{ color: '#94a3b8', fontWeight: 400 }}>(in order)</span>
              </label>
              {signers.length < 10 && (
                <button onClick={addSigner}
                  style={{ padding: '0.25rem 0.75rem', background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: 6, cursor: 'pointer', fontSize: '0.78rem', color: '#2563eb', fontWeight: 600 }}>
                  + Add Signer
                </button>
              )}
            </div>

            {signers.map((signer, index) => (
              <div key={index} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.5rem' }}>
                <div style={{ width: 24, height: 24, borderRadius: '50%', background: '#2563eb', color: 'white', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.75rem', fontWeight: 700, flexShrink: 0 }}>
                  {index + 1}
                </div>
                <input
                  type="email"
                  value={signer}
                  onChange={e => updateSigner(index, e.target.value)}
                  placeholder={`Signer ${index + 1} email`}
                  style={{ flex: 1, padding: '0.6rem 0.9rem', border: '1.5px solid #e2e8f0', borderRadius: 8, fontSize: '0.875rem', outline: 'none' }}
                />
                {signers.length > 1 && (
                  <button onClick={() => removeSigner(index)}
                    style={{ padding: '0.4rem 0.6rem', background: '#fee2e2', border: 'none', borderRadius: 6, cursor: 'pointer', color: '#dc2626', fontSize: '0.85rem' }}>
                    ✕
                  </button>
                )}
              </div>
            ))}

            {signers.length > 1 && (
              <p style={{ fontSize: '0.75rem', color: '#94a3b8', marginTop: '0.5rem' }}>
                ℹ️ Signers will receive email in order — Signer 2 gets email after Signer 1 signs.
              </p>
            )}
          </div>

          <div style={{ display: 'flex', gap: '0.75rem' }}>
            <button onClick={() => navigate('/dashboard')}
              style={{ flex: 1, padding: '0.7rem', background: '#f1f5f9', border: 'none', borderRadius: 8, fontWeight: 600, fontSize: '0.875rem', cursor: 'pointer' }}>
              Cancel
            </button>
            <button onClick={handleUpload} disabled={!file || loading}
              style={{ flex: 2, padding: '0.7rem', background: !file || loading ? '#93c5fd' : '#2563eb', color: 'white', border: 'none', borderRadius: 8, fontWeight: 700, fontSize: '0.875rem', cursor: !file || loading ? 'not-allowed' : 'pointer' }}>
              {loading ? 'Uploading...' : '⬆️ Upload PDF'}
            </button>
          </div>
        </div>
      </div>
    </AppShell>
  );
}
