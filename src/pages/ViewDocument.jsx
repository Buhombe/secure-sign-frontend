import { useEffect, useState, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import * as pdfjsLib from 'pdfjs-dist';
import api from '../services/api';
import AppShell from '../components/AppShell';

pdfjsLib.GlobalWorkerOptions.workerSrc = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js`;

const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:5000/api';

export default function ViewDocument() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [doc, setDoc] = useState(null);
  const [loading, setLoading] = useState(true);
  const [numPages, setNumPages] = useState(0);
  const [currentPage, setCurrentPage] = useState(1);
  const [pdfDoc, setPdfDoc] = useState(null);
  const [error, setError] = useState('');
  const canvasRef = useRef();

  useEffect(() => {
    const load = async () => {
      try {
        const { data } = await api.get(`/documents/${id}`);
        setDoc(data.document);

        const token = localStorage.getItem('token');
        const r = await fetch(`${API_BASE}/documents/${id}/serve`, {
          headers: { 'Authorization': `Bearer ${token}` }
        });
        if (!r.ok) throw new Error('Failed to load PDF');
        const arrayBuffer = await r.arrayBuffer();

        const loadedPdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
        setPdfDoc(loadedPdf);
        setNumPages(loadedPdf.numPages);
      } catch (e) {
        console.error(e);
        setError('Could not load PDF.');
      } finally {
        setLoading(false);
      }
    };
    load();
  }, [id]);

  useEffect(() => {
    if (!pdfDoc || !canvasRef.current) return;
    const renderPage = async () => {
      const page = await pdfDoc.getPage(currentPage);
      const viewport = page.getViewport({ scale: 1.5 });
      const canvas = canvasRef.current;
      canvas.height = viewport.height;
      canvas.width = viewport.width;
      await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
    };
    renderPage();
  }, [pdfDoc, currentPage]);

  return (
    <AppShell>
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
        <div style={{ background: 'white', borderBottom: '1px solid #e5e7eb', padding: '0.75rem 1.5rem', display: 'flex', alignItems: 'center', gap: '1rem', flexWrap: 'wrap' }}>
          <button onClick={() => navigate('/dashboard')}
            style={{ padding: '0.4rem 0.9rem', background: '#f1f5f9', border: 'none', borderRadius: 7, cursor: 'pointer', fontWeight: 600, fontSize: '0.875rem' }}>
            ← Back
          </button>
          <div style={{ flex: 1, fontWeight: 700, color: '#0f172a', fontSize: '0.95rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            📄 {doc?.original_name}
          </div>
          <span style={{ padding: '0.25rem 0.7rem', borderRadius: 20, fontSize: '0.75rem', fontWeight: 600, background: doc?.status === 'signed' ? '#dcfce7' : '#fef9c3', color: doc?.status === 'signed' ? '#16a34a' : '#ca8a04' }}>
            {doc?.status === 'signed' ? '✓ Signed' : '⏳ Pending'}
          </span>
          {doc?.status !== 'signed' && (
            <button onClick={() => navigate(`/sign/${id}`)}
              style={{ padding: '0.5rem 1.1rem', background: '#2563eb', color: 'white', border: 'none', borderRadius: 8, fontWeight: 700, fontSize: '0.875rem', cursor: 'pointer' }}>
              ✍️ Sign
            </button>
          )}
        </div>
        {doc?.signed_at && (
          <div style={{ background: '#f0fdf4', borderBottom: '1px solid #bbf7d0', padding: '0.5rem 1.5rem', fontSize: '0.8rem', color: '#16a34a', display: 'flex', gap: '1.5rem', flexWrap: 'wrap' }}>
            <span>✅ Signed by: <strong>{doc.signed_by}</strong></span>
            <span>🕐 {new Date(doc.signed_at).toLocaleString()}</span>
          </div>
        )}
        {numPages > 1 && (
          <div style={{ background: '#1e293b', padding: '0.5rem', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '1rem' }}>
            <button onClick={() => setCurrentPage(p => Math.max(1, p - 1))} disabled={currentPage === 1}
              style={{ padding: '0.3rem 0.8rem', background: '#334155', color: 'white', border: 'none', borderRadius: 6, cursor: 'pointer' }}>← Prev</button>
            <span style={{ color: 'white', fontSize: '0.85rem' }}>Page {currentPage} of {numPages}</span>
            <button onClick={() => setCurrentPage(p => Math.min(numPages, p + 1))} disabled={currentPage === numPages}
              style={{ padding: '0.3rem 0.8rem', background: '#334155', color: 'white', border: 'none', borderRadius: 6, cursor: 'pointer' }}>Next →</button>
          </div>
        )}
        <div style={{ flex: 1, background: '#334155', display: 'flex', justifyContent: 'center', alignItems: 'flex-start', overflow: 'auto', padding: '1rem' }}>
          {loading ? (
            <div style={{ color: '#94a3b8', marginTop: '4rem' }}>Loading...</div>
          ) : error ? (
            <div style={{ color: '#f87171', marginTop: '4rem' }}>{error}</div>
          ) : (
            <canvas ref={canvasRef} style={{ borderRadius: 6, boxShadow: '0 4px 24px rgba(0,0,0,0.3)', maxWidth: '100%' }} />
          )}
        </div>
      </div>
    </AppShell>
  );
}
