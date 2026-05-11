import { useAuth } from '../context/AuthContext';
import { useEffect, useState, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import * as pdfjsLib from 'pdfjs-dist';
import api from '../services/api';
import { getAuditLog, getStatusStyle } from '../services/documentApi';
import WorkflowTracker from '../components/WorkflowTracker';
import AppShell from '../components/AppShell';

pdfjsLib.GlobalWorkerOptions.workerSrc = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js`;

const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:5000/api';

const ACTION_ICONS = {
  SIGN: { icon: '✍️', color: '#16a34a', bg: '#dcfce7' },
  UPLOAD: { icon: '📤', color: '#2563eb', bg: '#dbeafe' },
  VIEW: { icon: '👁️', color: '#7c3aed', bg: '#ede9fe' },
  DOWNLOAD: { icon: '⬇️', color: '#0891b2', bg: '#cffafe' },
  REVOKE: { icon: '🚫', color: '#dc2626', bg: '#fee2e2' },
  LOGIN: { icon: '🔐', color: '#64748b', bg: '#f1f5f9' },
  default: { icon: '📋', color: '#64748b', bg: '#f1f5f9' },
};

function getActionStyle(action) {
  if (!action) return ACTION_ICONS.default;
  const key = Object.keys(ACTION_ICONS).find(k => action.toUpperCase().includes(k));
  return ACTION_ICONS[key] || ACTION_ICONS.default;
}

function formatAction(action) {
  if (!action) return '—';
  return action.replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
}

export default function ViewDocument() {
  const { getToken } = useAuth();
  const { id } = useParams();
  const navigate = useNavigate();

  const [doc, setDoc] = useState(null);
  const [loading, setLoading] = useState(true);
  const [numPages, setNumPages] = useState(0);
  const [currentPage, setCurrentPage] = useState(1);
  const [pdfDoc, setPdfDoc] = useState(null);
  const [pdfError, setPdfError] = useState('');
  const [tab, setTab] = useState('workflow');
  const [auditLog, setAuditLog] = useState([]);
  const [auditLoad, setAuditLoad] = useState(false);
  const [actionMsg, setActionMsg] = useState('');
  const [actionErr, setActionErr] = useState('');
  const canvasRef = useRef();

  // Load document + signers
  useEffect(() => {
    const load = async () => {
      try {
        const { data } = await api.get(`/documents/${id}`);
        const docData = data.document || data;

        try {
          const signersRes = await api.get(`/signers/${id}`);
          const raw = signersRes.data;
          docData.workflowSteps = Array.isArray(raw) ? raw : (raw.signers || []);
        } catch {
          docData.workflowSteps = [];
        }

        setDoc(docData);

        // Load PDF
        try {
          const r = await fetch(`${API_BASE}/documents/${id}/stream`, {
            headers: { Authorization: `Bearer ${getToken()}` },
          });
          if (!r.ok) throw new Error('Stream failed');
          const buf = await r.arrayBuffer();
          const loaded = await pdfjsLib.getDocument({ data: buf }).promise;
          setPdfDoc(loaded);
          setNumPages(loaded.numPages);
        } catch {
          setPdfError('Could not load PDF preview.');
        }
      } catch (e) {
        console.error(e);
      } finally {
        setLoading(false);
      }
    };
    load();
  }, [id]);

  // Render PDF page — fills container width on both mobile and desktop
  useEffect(() => {
    if (!pdfDoc || !canvasRef.current) return;
    (async () => {
      const page = await pdfDoc.getPage(currentPage);
      const container = canvasRef.current.parentElement;
      const padding = 32;
      const containerWidth = container
        ? container.clientWidth - padding
        : window.innerWidth - padding;
      const baseViewport = page.getViewport({ scale: 1 });
      const scale = containerWidth / baseViewport.width;
      const viewport = page.getViewport({ scale });
      const canvas = canvasRef.current;
      canvas.height = viewport.height;
      canvas.width = viewport.width;
      canvas.style.width = '100%';
      canvas.style.height = 'auto';
      await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
    })();
  }, [pdfDoc, currentPage]);

  // Load audit log
  useEffect(() => {
    if (tab !== 'audit' || auditLog.length) return;
    setAuditLoad(true);
    getAuditLog(id)
      .then(data => {
        const d = data.logs || data.data || data;
        setAuditLog(Array.isArray(d) ? d : []);
      })
      .catch(() => setAuditLog([]))
      .finally(() => setAuditLoad(false));
  }, [tab]);

  const flash = (msg, isErr = false) => {
    if (isErr) setActionErr(msg); else setActionMsg(msg);
    setTimeout(() => { setActionMsg(''); setActionErr(''); }, 3500);
  };

  if (loading) return (
    <AppShell>
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ textAlign: 'center', color: '#94a3b8' }}>
          <div style={{ fontSize: '2rem', marginBottom: 8 }}>⏳</div>
          <div style={{ fontSize: '0.875rem' }}>Loading document...</div>
        </div>
      </div>
    </AppShell>
  );

  const st = getStatusStyle(doc?.status);
  const isDone = ['completed', 'signed'].includes(doc?.status);
  const isVoided = doc?.status === 'voided';
  const hasWorkflow = doc?.workflowSteps?.length > 0;

  const TABS = [
    { key: 'workflow', label: 'Workflow', icon: '⚙️' },
    { key: 'pdf', label: 'Document', icon: '📄' },
    { key: 'audit', label: 'Audit Log', icon: '📋' },
  ];

  return (
    <AppShell>
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, background: '#f8fafc' }}>

        {/* Top bar */}
        <div style={{
          background: 'white', borderBottom: '1px solid #e2e8f0',
          padding: '0.875rem 1.5rem',
          display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap',
          boxShadow: '0 1px 3px rgba(0,0,0,0.04)'
        }}>
          <button onClick={() => navigate('/dashboard')} style={{
            padding: '0.4rem 0.9rem', background: '#f1f5f9', border: '1px solid #e2e8f0',
            borderRadius: 8, cursor: 'pointer', fontWeight: 600, fontSize: '0.82rem', color: '#475569',
            display: 'flex', alignItems: 'center', gap: 4
          }}>
            ← Back
          </button>

          <div style={{ flex: 1, fontWeight: 700, color: '#0f172a', fontSize: '0.9rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {doc?.original_name || doc?.display_title || 'Document'}
          </div>

          <span style={{
            padding: '0.3rem 0.8rem', borderRadius: 99, fontSize: '0.72rem', fontWeight: 700,
            background: st.bg, color: st.color, flexShrink: 0, letterSpacing: '0.02em'
          }}>
            {st.label}
          </span>

          {!isDone && !isVoided && doc?.status !== 'draft' && (
            <button onClick={() => navigate(`/sign/${id}`)} style={{
              padding: '0.45rem 1rem', background: '#2563eb', color: 'white',
              border: 'none', borderRadius: 8, fontWeight: 700, fontSize: '0.82rem', cursor: 'pointer', flexShrink: 0
            }}>
              ✍️ Sign
            </button>
          )}
        </div>

        {/* Flash messages */}
        {actionMsg && (
          <div style={{ background: '#f0fdf4', borderBottom: '1px solid #bbf7d0', padding: '0.6rem 1.5rem', fontSize: '0.82rem', color: '#16a34a', fontWeight: 500 }}>
            ✅ {actionMsg}
          </div>
        )}
        {actionErr && (
          <div style={{ background: '#fef2f2', borderBottom: '1px solid #fecaca', padding: '0.6rem 1.5rem', fontSize: '0.82rem', color: '#dc2626', fontWeight: 500 }}>
            ⚠️ {actionErr}
          </div>
        )}

        {/* Signed info bar */}
        {doc?.signed_at && (
          <div style={{
            background: '#f0fdf4', borderBottom: '1px solid #bbf7d0',
            padding: '0.6rem 1.5rem', fontSize: '0.8rem', color: '#16a34a',
            display: 'flex', gap: '1.5rem', flexWrap: 'wrap', alignItems: 'center'
          }}>
            <span>✅ Signed by: <strong>{doc.signed_by}</strong></span>
            <span style={{ color: '#4ade80' }}>•</span>
            <span>{new Date(doc.signed_at).toLocaleString()}</span>
          </div>
        )}

        {/* Tabs */}
        <div style={{ background: 'white', borderBottom: '1px solid #e2e8f0', display: 'flex', padding: '0 1.25rem', gap: 4 }}>
          {TABS.map(t => (
            <button key={t.key} onClick={() => setTab(t.key)} style={{
              padding: '0.8rem 1rem', background: 'none', border: 'none',
              borderBottom: `2px solid ${tab === t.key ? '#2563eb' : 'transparent'}`,
              color: tab === t.key ? '#2563eb' : '#64748b',
              fontWeight: tab === t.key ? 700 : 500, fontSize: '0.82rem',
              cursor: 'pointer', marginBottom: -1, display: 'flex', alignItems: 'center', gap: 5,
              transition: 'color 0.15s'
            }}>
              <span>{t.icon}</span> {t.label}
            </button>
          ))}
        </div>

        {/* ── TAB: Workflow ── */}
        {tab === 'workflow' && (
          <div style={{ flex: 1, overflow: 'auto', padding: '1.5rem' }}>
            <div style={{ maxWidth: 620, margin: '0 auto' }}>
              {hasWorkflow ? (
                <WorkflowTracker signers={doc.workflowSteps} />
              ) : (
                <div style={{
                  background: 'white', border: '1px solid #e2e8f0', borderRadius: 12,
                  padding: '3rem 2rem', textAlign: 'center',
                  boxShadow: '0 1px 3px rgba(0,0,0,0.06)'
                }}>
                  <div style={{ fontSize: '2.5rem', marginBottom: 12 }}>📋</div>
                  <div style={{ fontWeight: 700, color: '#0f172a', marginBottom: 6 }}>No workflow configured</div>
                  <p style={{ color: '#64748b', fontSize: '0.875rem', margin: 0 }}>
                    This document was signed directly without a multi-signer workflow.
                  </p>
                </div>
              )}
            </div>
          </div>
        )}

        {/* ── TAB: Document (PDF) — DocuSign style ── */}
        {tab === 'pdf' && (
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
            {/* Toolbar */}
            <div style={{
              background: '#1e293b', padding: '0.6rem 1.25rem',
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              borderBottom: '1px solid #334155', flexShrink: 0
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <button onClick={() => setCurrentPage(p => Math.max(1, p - 1))} disabled={currentPage === 1}
                  style={{
                    padding: '0.35rem 0.75rem', background: currentPage === 1 ? '#334155' : '#475569',
                    color: 'white', border: '1px solid #475569', borderRadius: 6,
                    cursor: currentPage === 1 ? 'default' : 'pointer', fontSize: '0.8rem',
                    opacity: currentPage === 1 ? 0.5 : 1
                  }}>← Prev</button>

                <div style={{
                  display: 'flex', alignItems: 'center', gap: 6,
                  background: '#334155', borderRadius: 6, padding: '0.3rem 0.75rem'
                }}>
                  <span style={{ color: '#e2e8f0', fontSize: '0.8rem', fontWeight: 500 }}>
                    Page
                  </span>
                  <span style={{ color: 'white', fontSize: '0.8rem', fontWeight: 700, minWidth: 20, textAlign: 'center' }}>
                    {currentPage}
                  </span>
                  <span style={{ color: '#64748b', fontSize: '0.8rem' }}>/</span>
                  <span style={{ color: '#94a3b8', fontSize: '0.8rem' }}>{numPages}</span>
                </div>

                <button onClick={() => setCurrentPage(p => Math.min(numPages, p + 1))} disabled={currentPage === numPages}
                  style={{
                    padding: '0.35rem 0.75rem', background: currentPage === numPages ? '#334155' : '#475569',
                    color: 'white', border: '1px solid #475569', borderRadius: 6,
                    cursor: currentPage === numPages ? 'default' : 'pointer', fontSize: '0.8rem',
                    opacity: currentPage === numPages ? 0.5 : 1
                  }}>Next →</button>
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: '0.75rem', color: '#64748b' }}>
                  {doc?.original_name}
                </span>
                {doc?.signed_at && (
                  <span style={{ fontSize: '0.7rem', background: '#166534', color: '#86efac', padding: '0.2rem 0.6rem', borderRadius: 99, fontWeight: 600 }}>
                    ✓ Signed
                  </span>
                )}
              </div>
            </div>

            {/* PDF canvas area */}
            <div style={{
              flex: 1, background: '#374151',
              overflow: 'auto', padding: '1rem',
              display: 'flex', flexDirection: 'column', alignItems: 'center'
            }}>
              {pdfError ? (
                <div style={{ color: '#f87171', marginTop: '4rem', textAlign: 'center' }}>
                  <div style={{ fontSize: '2.5rem', marginBottom: 8 }}>⚠️</div>
                  <div style={{ fontSize: '0.875rem' }}>{pdfError}</div>
                </div>
              ) : (
                <canvas ref={canvasRef} style={{
                  display: 'block',
                  width: '100%',
                  height: 'auto',
                  boxShadow: '0 4px 24px rgba(0,0,0,0.4)',
                  background: 'white'
                }} />
              )}
            </div>
          </div>
        )}

        {/* ── TAB: Audit Log ── */}
        {tab === 'audit' && (
          <div style={{ flex: 1, overflow: 'auto', padding: '1.5rem' }}>
            <div style={{ maxWidth: 720, margin: '0 auto' }}>
              {auditLoad ? (
                <div style={{ textAlign: 'center', color: '#94a3b8', padding: '3rem' }}>
                  <div style={{ fontSize: '1.5rem', marginBottom: 8 }}>⏳</div>
                  Loading audit log...
                </div>
              ) : auditLog.length === 0 ? (
                <div style={{
                  background: 'white', border: '1px solid #e2e8f0', borderRadius: 12,
                  padding: '3rem', textAlign: 'center', boxShadow: '0 1px 3px rgba(0,0,0,0.06)'
                }}>
                  <div style={{ fontSize: '2rem', marginBottom: 8 }}>📋</div>
                  <div style={{ fontWeight: 600, color: '#0f172a', marginBottom: 4 }}>No audit events yet</div>
                  <div style={{ fontSize: '0.82rem', color: '#94a3b8' }}>Events will appear here once activity occurs.</div>
                </div>
              ) : (
                <div style={{ background: 'white', border: '1px solid #e2e8f0', borderRadius: 12, overflow: 'hidden', boxShadow: '0 1px 3px rgba(0,0,0,0.06)' }}>
                  <div style={{ padding: '0.75rem 1.5rem', borderBottom: '1px solid #f1f5f9', background: '#f8fafc', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span style={{ fontSize: '0.72rem', fontWeight: 700, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                      Activity Timeline
                    </span>
                    <span style={{ fontSize: '0.72rem', color: '#94a3b8' }}>{auditLog.length} events</span>
                  </div>

                  {auditLog.map((ev, i) => {
                    const as = getActionStyle(ev.action);
                    const isLast = i === auditLog.length - 1;
                    return (
                      <div key={ev.id || i} style={{
                        display: 'flex', gap: '1rem', padding: '1rem 1.5rem',
                        borderBottom: isLast ? 'none' : '1px solid #f8fafc',
                      }}>
                        {/* Icon */}
                        <div style={{
                          width: 36, height: 36, borderRadius: '50%', flexShrink: 0,
                          background: as.bg, display: 'flex', alignItems: 'center',
                          justifyContent: 'center', fontSize: '1rem'
                        }}>
                          {as.icon}
                        </div>

                        {/* Content */}
                        <div style={{ flex: 1 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                            <span style={{ fontSize: '0.875rem', fontWeight: 600, color: '#0f172a' }}>
                              {formatAction(ev.action)}
                            </span>
                            {ev.user_email && (
                              <span style={{ fontSize: '0.75rem', color: '#64748b' }}>
                                by {ev.user_email}
                              </span>
                            )}
                          </div>
                          <div style={{ display: 'flex', gap: '1rem', marginTop: 4, flexWrap: 'wrap' }}>
                            <span style={{ fontSize: '0.72rem', color: '#94a3b8' }}>
                              {ev.timestamp ? new Date(ev.timestamp).toLocaleString() : '—'}
                            </span>
                            {ev.ip_address && (
                              <span style={{ fontSize: '0.72rem', color: '#94a3b8' }}>
                                IP: {ev.ip_address}
                              </span>
                            )}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        )}

      </div>
    </AppShell>
  );
}