import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import api from '../services/api';
import AppShell from '../components/AppShell';

export default function Dashboard() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [documents, setDocuments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('all');
  const [search, setSearch] = useState('');

  useEffect(() => {
    api.get('/documents').then(({ data }) => setDocuments(data.documents)).catch(console.error).finally(() => setLoading(false));
  }, []);

  const signed  = documents.filter(d => d.status === 'signed').length;
  const pending = documents.filter(d => d.status === 'pending').length;

  const filtered = documents
    .filter(d => {
      const mf = filter === 'all' || d.status === filter;
      const ms = d.original_name.toLowerCase().includes(search.toLowerCase());
      return mf && ms;
    })
    .slice(0, 10);

  return (
    <AppShell>
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
        {/* Header */}
        <header style={{ background: 'white', borderBottom: '1px solid #e5e7eb', padding: '0.75rem 1.5rem', display: 'flex', alignItems: 'center', gap: '1rem', flexWrap: 'wrap' }}>
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: '0.6rem', background: '#f1f5f9', borderRadius: 8, padding: '0.5rem 1rem', border: '1px solid #e2e8f0', maxWidth: 480 }}>
            <span style={{ color: '#94a3b8' }}>🔍</span>
            <input style={{ background: 'transparent', border: 'none', outline: 'none', color: '#0f172a', fontSize: '0.9rem', width: '100%' }}
              placeholder="Search documents..." value={search} onChange={e => setSearch(e.target.value)} />
          </div>
          <button onClick={() => navigate('/upload')}
            style={{ padding: '0.5rem 1.1rem', background: '#2563eb', color: 'white', border: 'none', borderRadius: 8, fontWeight: 700, fontSize: '0.875rem', cursor: 'pointer', whiteSpace: 'nowrap' }}>
            + Upload Document
          </button>
        </header>

        <main style={{ flex: 1, padding: 'clamp(1rem, 3vw, 2rem)', overflowX: 'hidden' }}>
          <h1 style={{ fontSize: 'clamp(1.1rem, 3vw, 1.4rem)', fontWeight: 700, color: '#0f172a', marginBottom: '1.5rem' }}>
            Welcome back, {user?.email?.split('@')[0]} 👋
          </h1>

          {/* 3 cards */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '1rem', marginBottom: '2rem' }}>
            {[
              { num: pending, label: 'Waiting for You',    sub: 'Requires your signature',         color: '#dc2626' },
              { num: 0,       label: 'Waiting for Others', sub: 'Sent, awaiting others',            color: '#d97706' },
              { num: signed,  label: 'Completed',          sub: 'Documents signed and finished',    color: '#2563eb' },
            ].map(({ num, label, sub, color }) => (
              <div key={label} style={{ background: 'white', borderRadius: 12, padding: '1.25rem 1.5rem', boxShadow: '0 1px 3px rgba(0,0,0,0.06)', border: '1px solid #f1f5f9' }}>
                <div style={{ fontSize: 'clamp(1.8rem, 4vw, 2.4rem)', fontWeight: 800, color, lineHeight: 1.1, marginBottom: '0.25rem' }}>{num}</div>
                <div style={{ fontSize: '0.875rem', fontWeight: 600, color: '#374151' }}>{label}</div>
                <div style={{ fontSize: '0.75rem', color: '#94a3b8', marginTop: '0.2rem' }}>{sub}</div>
              </div>
            ))}
          </div>

          {/* Table */}
          <div style={{ background: 'white', borderRadius: 14, border: '1px solid #e5e7eb', overflow: 'hidden' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '1rem 1.5rem', borderBottom: '1px solid #f1f5f9', flexWrap: 'wrap', gap: '0.5rem' }}>
              <h2 style={{ fontSize: '0.95rem', fontWeight: 700, color: '#0f172a' }}>Recent Documents</h2>
              <div style={{ display: 'flex', gap: '0.25rem' }}>
                {['all','pending','signed'].map(f => (
                  <button key={f} onClick={() => setFilter(f)} style={{
                    padding: '0.3rem 0.8rem', borderRadius: 6, border: '1px solid',
                    borderColor: filter === f ? '#bfdbfe' : '#e5e7eb',
                    background: filter === f ? '#eff6ff' : 'transparent',
                    color: filter === f ? '#2563eb' : '#64748b',
                    fontSize: '0.78rem', fontWeight: filter === f ? 700 : 500, cursor: 'pointer',
                  }}>{f === 'all' ? 'All' : f[0].toUpperCase() + f.slice(1)}</button>
                ))}
              </div>
            </div>

            {/* Responsive table — desktop columns, mobile cards */}
            <div className="doc-table">
              <style>{`
                .doc-table-head { display: flex; padding: 0.6rem 1.5rem; background: #fafafa; border-bottom: 1px solid #f1f5f9; }
                .doc-row { display: flex; align-items: center; padding: 0.85rem 1.5rem; border-bottom: 1px solid #f8fafc; gap: 0.5rem; }
                .doc-row:hover { background: #fafafa; }
                .doc-col-name { flex: 3; display: flex; align-items: center; gap: 0.6rem; min-width: 0; }
                .doc-col-status { flex: 2; text-align: center; }
                .doc-col-by { flex: 2; text-align: center; color: #64748b; font-size: 0.875rem; }
                .doc-col-date { flex: 2; text-align: center; color: #64748b; font-size: 0.875rem; }
                .doc-col-actions { flex: 1; display: flex; justify-content: flex-end; gap: 0.4rem; }
                @media (max-width: 640px) {
                  .doc-table-head { display: none; }
                  .doc-row { flex-direction: column; align-items: flex-start; padding: 1rem; gap: 0.6rem; }
                  .doc-col-name { width: 100%; }
                  .doc-col-status, .doc-col-by, .doc-col-date { text-align: left; }
                  .doc-col-actions { width: 100%; justify-content: flex-start; }
                }
              `}</style>

              <div className="doc-table-head" style={{ fontSize: '0.72rem', fontWeight: 700, color: '#94a3b8', letterSpacing: '0.05em', textTransform: 'uppercase' }}>
                <span style={{ flex: 3 }}>Name</span>
                <span style={{ flex: 2, textAlign: 'center' }}>Status</span>
                <span style={{ flex: 2, textAlign: 'center' }}>Sent By</span>
                <span style={{ flex: 2, textAlign: 'center' }}>Date</span>
                <span style={{ flex: 1 }}></span>
              </div>

              {loading ? (
                <div style={{ padding: '3rem', textAlign: 'center', color: '#94a3b8' }}>Loading...</div>
              ) : filtered.length === 0 ? (
                <div style={{ padding: '3rem', textAlign: 'center' }}>
                  <div style={{ fontSize: '2.5rem', marginBottom: '0.75rem' }}>📭</div>
                  <div style={{ color: '#94a3b8' }}>{search ? 'No results found.' : 'No documents yet.'}</div>
                </div>
              ) : filtered.map((doc, i) => (
                <div key={doc.id} className="doc-row" style={{ background: i % 2 === 0 ? 'white' : '#fafafa' }}>
                  <div className="doc-col-name">
                    <span style={{ fontSize: '1.25rem', flexShrink: 0 }}>📄</span>
                    <span style={{ fontWeight: 500, color: '#1e293b', fontSize: '0.875rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 260 }}>
                      {doc.original_name}
                    </span>
                  </div>
                  <div className="doc-col-status">
                    <span style={{ display: 'inline-block', padding: '0.25rem 0.7rem', borderRadius: 20, fontSize: '0.75rem', fontWeight: 600,
                      background: doc.status === 'signed' ? '#dcfce7' : '#fef9c3',
                      color: doc.status === 'signed' ? '#16a34a' : '#ca8a04' }}>
                      {doc.status === 'signed' ? 'Signed' : 'Pending'}
                    </span>
                  </div>
                  <div className="doc-col-by">You</div>
                  <div className="doc-col-date">
                    {new Date(doc.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}
                  </div>
                  <div className="doc-col-actions">
                    <button onClick={() => navigate(`/document/${doc.id}`)}
                      style={{ padding: '0.35rem 0.85rem', background: 'white', border: '1px solid #bfdbfe', borderRadius: 6, cursor: 'pointer', fontWeight: 600, fontSize: '0.8rem', color: '#2563eb' }}>
                      View
                    </button>
                    {doc.status !== 'signed' && (
                      <button onClick={() => navigate(`/sign/${doc.id}`)}
                        style={{ padding: '0.35rem 0.85rem', background: '#2563eb', color: 'white', border: 'none', borderRadius: 6, cursor: 'pointer', fontWeight: 600, fontSize: '0.8rem' }}>
                        Sign
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </main>
      </div>
    </AppShell>
  );
}