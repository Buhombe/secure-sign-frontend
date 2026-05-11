import { useAuth } from '../context/AuthContext';
// /frontend/src/pages/ViewDocument.jsx
// Updated: adds WorkflowTracker, Send/Void/Remind buttons, audit log tab
// Backward compatible — still shows PDF as before

import { useEffect, useState, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import * as pdfjsLib from 'pdfjs-dist';
import api from '../services/api';
import { sendDocument, voidDocument, remindDocument, getAuditLog, getStatusStyle } from '../services/documentApi';
import WorkflowTracker from '../components/WorkflowTracker';
import AppShell from '../components/AppShell';

pdfjsLib.GlobalWorkerOptions.workerSrc = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js`;

const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:5000/api';

export default function ViewDocument() {
  const { getToken } = useAuth(); // FIX P1: token from memory
  const { id }     = useParams();
  const navigate   = useNavigate();

  const [doc,        setDoc]        = useState(null);
  const [loading,    setLoading]    = useState(true);
  const [numPages,   setNumPages]   = useState(0);
  const [currentPage,setCurrentPage]= useState(1);
  const [pdfDoc,     setPdfDoc]     = useState(null);
  const [error,      setError]      = useState('');
  const [tab,        setTab]        = useState('workflow'); // 'workflow' | 'pdf' | 'audit'
  const [auditLog,   setAuditLog]   = useState([]);
  const [auditLoad,  setAuditLoad]  = useState(false);
  const [actionMsg,  setActionMsg]  = useState('');
  const [actionErr,  setActionErr]  = useState('');
  const [sending,    setSending]    = useState(false);
  const canvasRef = useRef();

  // ── Load document ──
  useEffect(() => {
    const load = async () => {
      try {
        const { data } = await api.get(`/documents/${id}`);
        const docData = data.document || data;

        // Load signers as workflow steps
        try {
          const signersRes = await api.get(`/signers/${id}`);
          docData.workflowSteps = signersRes.data.signers || signersRes.data || [];
        } catch {
          docData.workflowSteps = [];
        }

        setDoc(docData);

        // Load PDF
        const r = await fetch(`${API_BASE}/documents/${id}/stream`, {
          headers: { Authorization: `Bearer ${getToken()}` },
        });
        if (!r.ok) throw new Error('Failed to load PDF');
        const buf = await r.arrayBuffer();
        const loaded = await pdfjsLib.getDocument({ data: buf }).promise;
        setPdfDoc(loaded);
        setNumPages(loaded.numPages);
      } catch (e) {
        console.error(e);
        setError('Could not load document.');
      } finally {
        setLoading(false);
      }
    };
    load();
  }, [id]);

  // ── Render PDF page ──
  useEffect(() => {
    if (!pdfDoc || !canvasRef.current) return;
    const renderPage = async () => {
      const page     = await pdfDoc.getPage(currentPage);
      const viewport = page.getViewport({ scale: 1.5 });
      const canvas   = canvasRef.current;
      canvas.height  = viewport.height;
      canvas.width   = viewport.width;
      await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
    };
    renderPage();
  }, [pdfDoc, currentPage]);

  // ── Load audit log when tab opens ──
  useEffect(() => {
    if (tab !== 'audit' || auditLog.length) return;
    setAuditLoad(true);
    getAuditLog(id)
      .then(data => setAuditLog(data.logs || data.data || data))
      .catch(() => {})
      .finally(() => setAuditLoad(false));
  }, [tab]);

  // ── Actions ──
  const flash = (msg, isErr = false) => {
    if (isErr) setActionErr(msg); else setActionMsg(msg);
    setTimeout(() => { setActionMsg(''); setActionErr(''); }, 3000);
  };

  const handleSend = async () => {
    setSending(true);
    try {
      await sendDocument(id);
      flash('Document sent successfully!');
      // Reload doc to get updated status
      const { data } = await api.get(`/documents/${id}`);
      setDoc(data.document || data);
    } catch (e) {
      flash(e.response?.data?.error || 'Failed to send document', true);
    } finally {
      setSending(false);
    }
  };

  const handleVoid = async (reason) => {
    try {
      await voidDocument(id, reason);
      flash('Document voided.');
      const { data } = await api.get(`/documents/${id}`);
      setDoc(data.document || data);
    } catch (e) {
      flash(e.response?.data?.error || 'Failed to void document', true);
    }
  };

  const handleRemind = async () => {
    try {
      await remindDocument(id);
      flash('Reminders sent!');
    } catch (e) {
      flash(e.response?.data?.error || 'Failed to send reminders', true);
    }
  };

  if (loading) return (
    <AppShell>
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#94a3b8' }}>
        Loading...
      </div>
    </AppShell>
  );

  const st      = getStatusStyle(doc?.status);
  const isDone  = ['completed','signed'].includes(doc?.status);
  const isDraft = doc?.status === 'draft';
  const isVoided= doc?.status === 'voided';
  const hasWorkflow = doc?.workflowSteps?.length > 0;
  const canEdit = !isDone && !isVoided;

  return (
    <AppShell>
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>

        {/* ── Top bar ── */}
        <div style={{ background: 'white', borderBottom: '1px solid #e5e7eb', padding: '0.75rem 1.5rem', display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
          <button onClick={() => navigate('/dashboard')}
            style={{ padding: '0.4rem 0.9rem', background: '#f1f5f9', border: 'none', borderRadius: 7, cursor: 'pointer', fontWeight: 600, fontSize: '0.875rem' }}>
            ← Back
          </button>

          <div style={{ flex: 1, fontWeight: 700, color: '#0f172a', fontSize: '0.95rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            📄 {doc?.original_name || doc?.display_title}
          </div>

          {/* Status badge */}
          <span style={{ padding: '0.25rem 0.7rem', borderRadius: 20, fontSize: '0.75rem', fontWeight: 600, background: st.bg, color: st.color, flexShrink: 0 }}>
            {st.label}
          </span>

          {/* Action buttons */}
          {isDraft && (
            <button onClick={handleSend} disabled={sending}
              style={{ padding: '0.5rem 1.1rem', background: '#16a34a', color: 'white', border: 'none', borderRadius: 8, fontWeight: 700, fontSize: '0.875rem', cursor: 'pointer', flexShrink: 0 }}>
              {sending ? 'Sending...' : '🚀 Send'}
            </button>
          )}

          {doc?.status === 'in_progress' && (
            <button onClick={handleRemind}
              style={{ padding: '0.5rem 1.1rem', background: '#f59e0b', color: 'white', border: 'none', borderRadius: 8, fontWeight: 700, fontSize: '0.875rem', cursor: 'pointer', flexShrink: 0 }}>
              🔔 Remind
            </button>
          )}

          {!isDone && !isVoided && doc?.status !== 'draft' && (
            <button onClick={() => navigate(`/sign/${id}`)}
              style={{ padding: '0.5rem 1.1rem', background: '#2563eb', color: 'white', border: 'none', borderRadius: 8, fontWeight: 700, fontSize: '0.875rem', cursor: 'pointer', flexShrink: 0 }}>
              ✍️ Sign
            </button>
          )}
        </div>

        {/* ── Flash messages ── */}
        {actionMsg && (
          <div style={{ background: '#f0fdf4', borderBottom: '1px solid #bbf7d0', padding: '0.5rem 1.5rem', fontSize: '0.85rem', color: '#16a34a' }}>
            ✅ {actionMsg}
          </div>
        )}
        {actionErr && (
          <div style={{ background: '#fef2f2', borderBottom: '1px solid #fecaca', padding: '0.5rem 1.5rem', fontSize: '0.85rem', color: '#dc2626' }}>
            ⚠️ {actionErr}
          </div>
        )}

        {/* ── Signed info bar ── */}
        {doc?.signed_at && (
          <div style={{ background: '#f0fdf4', borderBottom: '1px solid #bbf7d0', padding: '0.5rem 1.5rem', fontSize: '0.8rem', color: '#16a34a', display: 'flex', gap: '1.5rem', flexWrap: 'wrap' }}>
            <span>✅ Signed by: <strong>{doc.signed_by}</strong></span>
            <span>🕐 {new Date(doc.signed_at).toLocaleString()}</span>
          </div>
        )}

        {/* ── Tabs ── */}
        <div style={{ background: 'white', borderBottom: '1px solid #e5e7eb', display: 'flex', padding: '0 1.5rem' }}>
          {[
            { key: 'workflow', label: '⚙️ Workflow'  },
            { key: 'pdf',      label: '📄 Document'  },
            { key: 'audit',    label: '📋 Audit Log' },
          ].map(t => (
            <button key={t.key} onClick={() => setTab(t.key)} style={{
              padding: '0.75rem 1rem', background: 'none', border: 'none',
              borderBottom: `2px solid ${tab === t.key ? '#2563eb' : 'transparent'}`,
              color: tab === t.key ? '#2563eb' : '#64748b',
              fontWeight: tab === t.key ? 700 : 500, fontSize: '0.875rem',
              cursor: 'pointer', marginBottom: -1,
            }}>{t.label}</button>
          ))}
        </div>

        {/* ── Tab: Workflow ── */}
        {tab === 'workflow' && (
          <div style={{ flex: 1, overflow: 'auto', padding: '1.5rem' }}>
            {hasWorkflow ? (
              <div style={{ maxWidth: 680, margin: '0 auto' }}>
                <WorkflowTracker signers={doc.workflowSteps} />
              </div>
            ) : (
              <div style={{ maxWidth: 480, margin: '60px auto', textAlign: 'center' }}>
                <div style={{ fontSize: '2.5rem', marginBottom: 12 }}>📋</div>
                <p style={{ color: '#64748b', fontSize: 14 }}>
                  This document has no workflow steps configured.<br />
                  {isDraft && 'Add recipients before sending.'}
                </p>
                {isDraft && (
                  <button onClick={handleSend} disabled={sending}
                    style={{ marginTop: 16, padding: '0.7rem 1.5rem', background: '#16a34a', color: 'white', border: 'none', borderRadius: 8, fontWeight: 700, fontSize: '0.9rem', cursor: 'pointer' }}>
                    {sending ? 'Sending...' : '🚀 Send Document'}
                  </button>
                )}
              </div>
            )}
          </div>
        )}

        {/* ── Tab: PDF ── */}
        {tab === 'pdf' && (
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
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
              {error ? (
                <div style={{ color: '#f87171', marginTop: '4rem' }}>{error}</div>
              ) : (
                <canvas ref={canvasRef} style={{ borderRadius: 6, boxShadow: '0 4px 24px rgba(0,0,0,0.3)', maxWidth: '100%' }} />
              )}
            </div>
          </div>
        )}

        {/* ── Tab: Audit Log ── */}
        {tab === 'audit' && (
          <div style={{ flex: 1, overflow: 'auto', padding: '1.5rem' }}>
            <div style={{ maxWidth: 720, margin: '0 auto' }}>
              {auditLoad ? (
                <div style={{ textAlign: 'center', color: '#94a3b8', padding: '3rem' }}>Loading audit log...</div>
              ) : auditLog.length === 0 ? (
                <div style={{ textAlign: 'center', color: '#94a3b8', padding: '3rem' }}>No audit events yet.</div>
              ) : auditLog.map((ev, i) => (
                <div key={ev.id || i} style={{ display: 'flex', gap: 12, paddingBottom: 12, marginBottom: 12, borderBottom: '1px solid #f1f5f9' }}>
                  <div style={{ width: 32, height: 32, borderRadius: '50%', background: '#eff6ff', color: '#2563eb', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, flexShrink: 0 }}>
                    {ev.action?.toLowerCase().includes('sign') ? '✍️' : ev.action?.toLowerCase().includes('send') ? '📤' : ev.action?.toLowerCase().includes('view') ? '👁️' : ev.action?.toLowerCase().includes('void') ? '🚫' : ev.action?.toLowerCase().includes('complete') ? '✅' : '📋'}
                  </div>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: '#0f172a' }}>
                      {ev.action?.replace(/_/g, ' ')}
                      {(ev.user_email) && (
                        <span style={{ fontWeight: 400, color: '#475569' }}> — {ev.user_email}</span>
                      )}
                    </div>
                    <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 2, display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                      <span>{new Date(ev.timestamp).toLocaleString()}</span>
                      {ev.ip_address && <span>IP: {ev.ip_address}</span>}
                      {ev.geo_city && <span>📍 {ev.geo_city}{ev.geo_country ? `, ${ev.geo_country}` : ''}</span>}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

      </div>
    </AppShell>
  );
}