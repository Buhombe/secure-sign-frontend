// Manage.jsx — Documents management page (modernized)
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import api from '../services/api';
import { getStatusStyle } from '../services/documentApi';
import AppShell from '../components/AppShell';

/* ─── Status Badge ───────────────────────────────────────────── */
function StatusBadge({ status }) {
  const st = getStatusStyle(status);
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 5,
      padding: '3px 10px', borderRadius: 20,
      fontSize: '0.72rem', fontWeight: 600,
      background: st.bg, color: st.color,
    }}>
      {st.label}
    </span>
  );
}

/* ─── Document Card (Mobile) ─────────────────────────────────── */
function DocCard({ doc, onView, onSign, onFields, onCertificate, onLink, downloading }) {
  const isDone     = ['completed','signed'].includes(doc.status);
  const isTerminal = ['voided','declined'].includes(doc.status);
  return (
    <div style={{
      background: 'white', borderRadius: 14, border: '1px solid #E2E8F0',
      padding: '1.1rem 1.1rem', boxShadow: '0 1px 3px rgba(0,0,0,0.04)',
      display: 'flex', flexDirection: 'column', gap: '0.75rem',
    }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: '0.75rem' }}>
        <div style={{ width: 40, height: 40, borderRadius: 10, background: '#EFF6FF', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
          <svg width="18" height="18" fill="none" viewBox="0 0 24 24" stroke="#2563EB" strokeWidth="1.8">
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/>
          </svg>
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 600, fontSize: '0.875rem', color: '#0F172A', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {doc.original_name}
          </div>
          <div style={{ fontSize: '0.72rem', color: '#94A3B8', marginTop: '0.2rem' }}>
            {new Date(doc.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}
          </div>
        </div>
        <StatusBadge status={doc.status} />
      </div>
      <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap', paddingTop: '0.25rem', borderTop: '1px solid #F1F5F9' }}>
        <button onClick={onView} style={btnStyle('#2563EB', 'ghost')}>View</button>
        {!isDone && !isTerminal && <button onClick={onSign} style={btnStyle('#2563EB', 'solid')}>Sign</button>}
        {!isDone && !isTerminal && <button onClick={onFields} style={btnStyle('#D97706', 'solid')}>Fields</button>}
        {isDone && <button onClick={onCertificate} disabled={downloading} style={btnStyle('#16A34A', 'solid')}>{downloading ? '…' : 'Certificate'}</button>}
        {!isDone && !isTerminal && <button onClick={onLink} style={btnStyle('#64748B', 'ghost')}>📋 Link</button>}
      </div>
    </div>
  );
}

function btnStyle(color, variant) {
  if (variant === 'solid') return { padding: '0.3rem 0.75rem', background: color, color: 'white', border: 'none', borderRadius: 7, cursor: 'pointer', fontSize: '0.78rem', fontWeight: 600 };
  return { padding: '0.3rem 0.75rem', background: 'white', border: `1px solid ${color}33`, borderRadius: 7, cursor: 'pointer', fontSize: '0.78rem', fontWeight: 600, color };
}

/* ─── Desktop Table Row ──────────────────────────────────────── */
function TableRow({ doc, idx, onView, onSign, onFields, onCertificate, onLink, downloading, signers }) {
  const isDone     = ['completed','signed'].includes(doc.status);
  const isTerminal = ['voided','declined'].includes(doc.status);
  const signerCount = signers?.length || 0;
  return (
    <div style={{
      display: 'flex', alignItems: 'center', padding: '0.9rem 1.25rem',
      borderBottom: '1px solid #F8FAFC', gap: '0.75rem',
      background: idx % 2 === 0 ? 'white' : '#FAFBFC',
      transition: 'background 0.12s',
    }}
    onMouseEnter={e => e.currentTarget.style.background = '#F8FAFC'}
    onMouseLeave={e => e.currentTarget.style.background = idx % 2 === 0 ? 'white' : '#FAFBFC'}
    >
      {/* Name */}
      <div style={{ flex: 3, display: 'flex', alignItems: 'center', gap: '0.75rem', minWidth: 0 }}>
        <div style={{ width: 36, height: 36, borderRadius: 9, background: '#EFF6FF', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
          <svg width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="#2563EB" strokeWidth="1.8">
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/>
          </svg>
        </div>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontWeight: 500, color: '#1E293B', fontSize: '0.875rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 260 }}>
            {doc.original_name}
          </div>
          {signerCount > 0 && (
            <div style={{ fontSize: '0.7rem', color: '#94A3B8', marginTop: 1 }}>{signerCount} signer{signerCount !== 1 ? 's' : ''}</div>
          )}
        </div>
      </div>
      {/* Status */}
      <div style={{ flex: 1.5, display: 'flex', justifyContent: 'center' }}>
        <StatusBadge status={doc.status} />
      </div>
      {/* Date */}
      <div style={{ flex: 1.5, textAlign: 'center', color: '#64748B', fontSize: '0.82rem' }}>
        {new Date(doc.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}
      </div>
      {/* Actions */}
      <div style={{ flex: 2, display: 'flex', justifyContent: 'flex-end', gap: '0.4rem', flexWrap: 'wrap' }}>
        <button onClick={onView} style={btnStyle('#2563EB', 'ghost')}>View</button>
        {!isDone && !isTerminal && <button onClick={onSign} style={btnStyle('#2563EB', 'solid')}>Sign</button>}
        {!isDone && !isTerminal && <button onClick={onFields} style={btnStyle('#D97706', 'solid')}>Fields</button>}
        {isDone && <button onClick={onCertificate} disabled={downloading} style={btnStyle('#16A34A', 'solid')}>{downloading ? '…' : '📜 Cert'}</button>}
        {!isDone && !isTerminal && (
          <button onClick={onLink}
            style={{ padding: '0.3rem 0.55rem', background: 'white', border: '1px solid #E2E8F0', borderRadius: 7, cursor: 'pointer', fontSize: '0.78rem', fontWeight: 600, color: '#64748B' }}>
            📋
          </button>
        )}
      </div>
    </div>
  );
}

/* ─── Main Manage Page ───────────────────────────────────────── */
export default function Manage() {
  const { getToken } = useAuth();
  const navigate = useNavigate();
  const [documents,  setDocuments]  = useState([]);
  const [loading,    setLoading]    = useState(true);
  const [filter,     setFilter]     = useState('all');
  const [search,     setSearch]     = useState('');
  const [signersMap, setSignersMap] = useState({});
  const [downloading, setDownloading] = useState({});

  useEffect(() => {
    api.get('/documents').then(({ data }) => {
      const docs = data.documents || data;
      setDocuments(docs);
      docs.forEach(doc => {
        api.get(`/signers/${doc.id}`).then(({ data: sd }) => {
          setSignersMap(prev => ({ ...prev, [doc.id]: sd.signers }));
        }).catch(() => {});
      });
    }).catch(console.error).finally(() => setLoading(false));
  }, []);

  const filtered = documents.filter(d => {
    const matchFilter =
      filter === 'all' ||
      d.status === filter ||
      (filter === 'signed'    && ['signed','completed'].includes(d.status)) ||
      (filter === 'pending'   && ['pending','draft'].includes(d.status)) ||
      (filter === 'declined'  && d.status === 'declined');
    const matchSearch = (d.original_name || '').toLowerCase().includes(search.toLowerCase());
    return matchFilter && matchSearch;
  });

  const downloadCertificate = async (docId, name) => {
    setDownloading(prev => ({ ...prev, [docId]: true }));
    try {
      const token = getToken();
      const res = await fetch(`${api.defaults.baseURL}/fields/${docId}/certificate`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) { const b = await res.json().catch(() => ({})); throw new Error(b.error || 'Certificate not available.'); }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = `certificate-${name || 'document'}.pdf`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    } catch (e) { alert(e.message || 'Could not download certificate.'); }
    finally { setDownloading(prev => ({ ...prev, [docId]: false })); }
  };

  const handleLink = async (doc) => {
    try {
      const { data: info } = await api.get(`/signers/${doc.id}`);
      const pending = info.signers?.find(s => s.status === 'pending');
      if (!pending?.email) { alert('No pending signer available.'); return; }
      const { data } = await api.post(`/signers/${doc.id}/regenerate-link`, { email: pending.email });
      await navigator.clipboard.writeText(data.link);
      alert(`Signing link copied for ${pending.email}.\nAny previous link for this signer is now invalid.`);
    } catch (err) { alert(err?.response?.data?.error || 'Could not generate link.'); }
  };

  const FILTERS = [
    { key: 'all',         label: 'All',         count: documents.length },
    { key: 'pending',     label: 'Pending',     count: documents.filter(d => ['pending','draft'].includes(d.status)).length },
    { key: 'in_progress', label: 'In Progress', count: documents.filter(d => d.status === 'in_progress').length },
    { key: 'signed',      label: 'Completed',   count: documents.filter(d => ['signed','completed'].includes(d.status)).length },
    { key: 'declined',    label: 'Declined',    count: documents.filter(d => d.status === 'declined').length },
    { key: 'voided',      label: 'Voided',      count: documents.filter(d => d.status === 'voided').length },
  ];

  return (
    <AppShell>
      <div className="fade-in" style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
        {/* Page header */}
        <div style={{ padding: '1.25rem clamp(1rem,4vw,2rem) 0', background: 'transparent' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '0.75rem', marginBottom: '1.25rem' }}>
            <div>
              <h1 style={{ fontSize: 'clamp(1.1rem,3vw,1.4rem)', fontWeight: 800, color: '#0F172A', letterSpacing: '-0.02em' }}>Documents</h1>
              <p style={{ fontSize: '0.875rem', color: '#64748B', marginTop: 2 }}>{documents.length} total document{documents.length !== 1 ? 's' : ''}</p>
            </div>
            <button onClick={() => navigate('/upload')}
              style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', padding: '0.55rem 1.1rem', background: '#2563EB', color: 'white', border: 'none', borderRadius: 10, fontWeight: 700, fontSize: '0.875rem', cursor: 'pointer', boxShadow: '0 2px 8px rgba(37,99,235,0.28)' }}
              onMouseEnter={e => e.currentTarget.style.background = '#1D4ED8'}
              onMouseLeave={e => e.currentTarget.style.background = '#2563EB'}
            >
              <svg width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2.5"><path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4"/></svg>
              Upload
            </button>
          </div>

          {/* Search + filter bar */}
          <div style={{ background: 'white', borderRadius: 14, border: '1px solid #E2E8F0', padding: '0.85rem 1.1rem', marginBottom: '1.25rem', display: 'flex', gap: '0.75rem', flexWrap: 'wrap', alignItems: 'center', boxShadow: '0 1px 3px rgba(0,0,0,0.04)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', background: '#F8FAFC', border: '1px solid #E2E8F0', borderRadius: 9, padding: '0.4rem 0.85rem', flex: 1, minWidth: 180 }}>
              <svg width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="#94A3B8" strokeWidth="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35" strokeLinecap="round"/></svg>
              <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search by name..."
                style={{ background: 'transparent', border: 'none', outline: 'none', fontSize: '0.875rem', color: '#0F172A', width: '100%' }}
              />
              {search && (
                <button onClick={() => setSearch('')} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#94A3B8', fontSize: '1rem', lineHeight: 1 }}>×</button>
              )}
            </div>
            <div style={{ display: 'flex', gap: '0.25rem', flexWrap: 'wrap' }}>
              {FILTERS.map(f => (
                <button key={f.key} onClick={() => setFilter(f.key)}
                  style={{
                    padding: '0.35rem 0.85rem', borderRadius: 20,
                    border: `1px solid ${filter === f.key ? '#BFDBFE' : '#E2E8F0'}`,
                    background: filter === f.key ? '#EFF6FF' : 'transparent',
                    color: filter === f.key ? '#2563EB' : '#64748B',
                    fontSize: '0.78rem', fontWeight: filter === f.key ? 700 : 500, cursor: 'pointer',
                    display: 'flex', alignItems: 'center', gap: 4,
                  }}>
                  {f.label}
                  <span style={{ background: filter === f.key ? '#BFDBFE' : '#F1F5F9', color: filter === f.key ? '#1D4ED8' : '#94A3B8', borderRadius: 10, padding: '0 5px', fontSize: '0.67rem', fontWeight: 700 }}>
                    {f.count}
                  </span>
                </button>
              ))}
            </div>
          </div>
        </div>

        <div style={{ padding: '0 clamp(1rem,4vw,2rem) clamp(1rem,4vw,2rem)' }}>
          {loading ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem' }}>
              {[1,2,3,4].map(i => (
                <div key={i} className="pulse" style={{ height: 64, background: 'white', borderRadius: 12, border: '1px solid #E2E8F0' }} />
              ))}
            </div>
          ) : filtered.length === 0 ? (
            <div style={{ background: 'white', borderRadius: 16, border: '1px solid #E2E8F0', padding: '3.5rem 2rem', textAlign: 'center', boxShadow: '0 1px 3px rgba(0,0,0,0.04)' }}>
              <div style={{ width: 56, height: 56, borderRadius: '50%', background: '#F1F5F9', margin: '0 auto 1rem', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <svg width="24" height="24" fill="none" viewBox="0 0 24 24" stroke="#94A3B8" strokeWidth="1.5"><path strokeLinecap="round" strokeLinejoin="round" d="M9 13h6m-3-3v6m-9 1V7a2 2 0 012-2h6l2 2h4a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z"/></svg>
              </div>
              <div style={{ fontWeight: 600, color: '#374151', marginBottom: '0.35rem' }}>{search ? 'No results' : 'No documents'}</div>
              <div style={{ fontSize: '0.84rem', color: '#94A3B8', marginBottom: '1.25rem' }}>{search ? 'Try adjusting your search.' : 'Upload your first document to get started.'}</div>
              {!search && (
                <button onClick={() => navigate('/upload')}
                  style={{ padding: '0.55rem 1.2rem', background: '#2563EB', color: 'white', border: 'none', borderRadius: 9, fontWeight: 600, fontSize: '0.875rem', cursor: 'pointer' }}>
                  Upload Document
                </button>
              )}
            </div>
          ) : (
            <>
              {/* Desktop Table */}
              <div style={{ display: 'none' }} className="hs-desktop-table">
                <div style={{ background: 'white', borderRadius: 16, border: '1px solid #E2E8F0', overflow: 'hidden', boxShadow: '0 1px 4px rgba(0,0,0,0.04)' }}>
                  <div style={{ display: 'flex', padding: '0.65rem 1.25rem', borderBottom: '1px solid #F1F5F9', background: '#FAFBFC' }}>
                    <span style={{ flex: 3, fontSize: '0.7rem', fontWeight: 700, color: '#94A3B8', letterSpacing: '0.06em', textTransform: 'uppercase' }}>Document</span>
                    <span style={{ flex: 1.5, fontSize: '0.7rem', fontWeight: 700, color: '#94A3B8', letterSpacing: '0.06em', textTransform: 'uppercase', textAlign: 'center' }}>Status</span>
                    <span style={{ flex: 1.5, fontSize: '0.7rem', fontWeight: 700, color: '#94A3B8', letterSpacing: '0.06em', textTransform: 'uppercase', textAlign: 'center' }}>Date</span>
                    <span style={{ flex: 2 }} />
                  </div>
                  {filtered.map((doc, i) => (
                    <TableRow key={doc.id} doc={doc} idx={i}
                      onView={() => navigate(`/document/${doc.id}`)}
                      onSign={() => navigate(`/sign/${doc.id}`)}
                      onFields={() => navigate(`/place-fields/${doc.id}`)}
                      onCertificate={() => downloadCertificate(doc.id, doc.original_name)}
                      onLink={() => handleLink(doc)}
                      downloading={!!downloading[doc.id]}
                      signers={signersMap[doc.id]}
                    />
                  ))}
                </div>
              </div>

              {/* Mobile Cards */}
              <div className="hs-mobile-cards" style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                {filtered.map(doc => (
                  <DocCard key={doc.id} doc={doc}
                    onView={() => navigate(`/document/${doc.id}`)}
                    onSign={() => navigate(`/sign/${doc.id}`)}
                    onFields={() => navigate(`/place-fields/${doc.id}`)}
                    onCertificate={() => downloadCertificate(doc.id, doc.original_name)}
                    onLink={() => handleLink(doc)}
                    downloading={!!downloading[doc.id]}
                  />
                ))}
              </div>

              <style>{`
                @media (min-width: 640px) {
                  .hs-desktop-table { display: block !important; }
                  .hs-mobile-cards  { display: none !important; }
                }
              `}</style>
            </>
          )}
        </div>
      </div>
    </AppShell>
  );
}
