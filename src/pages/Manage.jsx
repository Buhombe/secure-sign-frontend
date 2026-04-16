import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../services/api';
import AppShell from '../components/AppShell';

export default function Manage() {
  const navigate = useNavigate();
  const [documents, setDocuments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('all');
  const [search, setSearch] = useState('');

  useEffect(() => {
    api.get('/documents').then(({ data }) => {
      setDocuments(data.documents);
      // Fetch signers for each document
      data.documents.forEach(doc => {
        api.get(`/signers/${doc.id}`).then(({ data: sd }) => {
          setSignersMap(prev => ({ ...prev, [doc.id]: sd.signers }));
        }).catch(() => {});
      });
    }).catch(console.error).finally(() => setLoading(false));
  }, []);

  const filtered = documents.filter(d => {
    const mf = filter === 'all' || d.status === filter;
    const ms = d.original_name.toLowerCase().includes(search.toLowerCase());
    return mf && ms;
  });

  return (
    <AppShell>
      <div style={{ flex: 1 }}>
        <header style={{ background: 'white', borderBottom: '1px solid #e5e7eb', padding: '1rem 1.5rem', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '0.75rem' }}>
          <h1 style={{ fontSize: '1.1rem', fontWeight: 700, color: '#0f172a' }}>Manage Documents</h1>
          <button onClick={() => navigate('/upload')}
            style={{ padding: '0.5rem 1rem', background: '#2563eb', color: 'white', border: 'none', borderRadius: 8, fontWeight: 700, fontSize: '0.875rem', cursor: 'pointer' }}>
            + Upload New
          </button>
        </header>

        <main style={{ padding: 'clamp(1rem, 3vw, 2rem)' }}>
          {/* Search + filters */}
          <div style={{ display: 'flex', gap: '0.75rem', marginBottom: '1.25rem', flexWrap: 'wrap', alignItems: 'center' }}>
            <div style={{ flex: 1, minWidth: 200, display: 'flex', alignItems: 'center', gap: '0.6rem', background: 'white', border: '1px solid #e2e8f0', borderRadius: 8, padding: '0.5rem 1rem' }}>
              <span style={{ color: '#94a3b8' }}>🔍</span>
              <input style={{ background: 'transparent', border: 'none', outline: 'none', fontSize: '0.875rem', width: '100%', color: '#0f172a' }}
                placeholder="Search by name..." value={search} onChange={e => setSearch(e.target.value)} />
            </div>
            <div style={{ display: 'flex', gap: '0.25rem', background: 'white', border: '1px solid #e5e7eb', borderRadius: 8, overflow: 'hidden' }}>
              {['all','pending','signed'].map(f => (
                <button key={f} onClick={() => setFilter(f)} style={{
                  padding: '0.5rem 1rem', border: 'none', background: filter === f ? '#2563eb' : 'transparent',
                  color: filter === f ? 'white' : '#64748b', fontSize: '0.8rem', fontWeight: filter === f ? 700 : 500, cursor: 'pointer',
                }}>{f === 'all' ? 'All' : f[0].toUpperCase() + f.slice(1)}</button>
              ))}
            </div>
          </div>

          {/* Stats row */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: '0.75rem', marginBottom: '1.5rem' }}>
            {[
              { label: 'Total', count: documents.length, color: '#0f172a' },
              { label: 'Pending', count: documents.filter(d => d.status === 'pending').length, color: '#d97706' },
              { label: 'Signed', count: documents.filter(d => d.status === 'signed').length, color: '#16a34a' },
            ].map(({ label, count, color }) => (
              <div key={label} style={{ background: 'white', borderRadius: 10, padding: '0.9rem 1.1rem', border: '1px solid #f1f5f9', boxShadow: '0 1px 3px rgba(0,0,0,0.04)' }}>
                <div style={{ fontSize: '1.6rem', fontWeight: 800, color }}>{count}</div>
                <div style={{ fontSize: '0.78rem', color: '#64748b', marginTop: '0.1rem' }}>{label}</div>
              </div>
            ))}
          </div>

          {/* Documents grid/list */}
          {loading ? (
            <div style={{ textAlign: 'center', padding: '3rem', color: '#94a3b8' }}>Loading...</div>
          ) : filtered.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '3rem', background: 'white', borderRadius: 12, border: '1px solid #e5e7eb' }}>
              <div style={{ fontSize: '2.5rem', marginBottom: '0.75rem' }}>📁</div>
              <div style={{ color: '#94a3b8' }}>No documents found.</div>
            </div>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: '1rem' }}>
              {filtered.map(doc => (
                <div key={doc.id} style={{ background: 'white', borderRadius: 12, border: '1px solid #e5e7eb', padding: '1.25rem', boxShadow: '0 1px 3px rgba(0,0,0,0.05)', display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                  <div style={{ display: 'flex', alignItems: 'flex-start', gap: '0.75rem' }}>
                    <span style={{ fontSize: '2rem', flexShrink: 0 }}>📄</span>
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div style={{ fontWeight: 600, fontSize: '0.875rem', color: '#0f172a', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {doc.original_name}
                      </div>
                      <div style={{ fontSize: '0.75rem', color: '#94a3b8', marginTop: '0.2rem' }}>
                        {new Date(doc.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}
                      </div>
                    </div>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <span style={{ display: 'inline-block', padding: '0.25rem 0.65rem', borderRadius: 20, fontSize: '0.72rem', fontWeight: 600,
                      background: doc.status === 'signed' ? '#dcfce7' : '#fef9c3',
                      color: doc.status === 'signed' ? '#16a34a' : '#ca8a04' }}>
                      {doc.status === 'signed' ? '✓ Signed' : '⏳ Pending'}
                    </span>
                    <div style={{ display: 'flex', gap: '0.4rem' }}>
                      <button onClick={() => navigate(`/document/${doc.id}`)}
                        style={{ padding: '0.3rem 0.75rem', background: 'white', border: '1px solid #bfdbfe', borderRadius: 6, cursor: 'pointer', fontSize: '0.78rem', color: '#2563eb', fontWeight: 600 }}>
                        View
                      </button>
                      {doc.status !== 'signed' && (
                        <button onClick={() => navigate(`/sign/${doc.id}`)}
                          style={{ padding: '0.3rem 0.75rem', background: '#2563eb', color: 'white', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: '0.78rem', fontWeight: 600 }}>
                          Sign
                        </button>
                      )}
                      {doc.status !== 'signed' && (
                        <button onClick={async () => {
                          try {
                            const { data } = await import('../services/api').then(m => m.default.get(`/signers/${doc.id}`));
                            const pendingSigner = data.signers?.find(s => s.status === 'pending');
                            const email = pendingSigner?.email || '';
                            const link = `${window.location.origin}/sign/${doc.id}${email ? '?signer=' + encodeURIComponent(email) : ''}`;
                            navigator.clipboard.writeText(link);
                            alert(`Signing link copied!\nFor: ${email || 'anyone'}`);
                          } catch {
                            const link = `${window.location.origin}/sign/${doc.id}`;
                            navigator.clipboard.writeText(link);
                            alert('Signing link copied!');
                          }
                        }}
                          style={{ padding: '0.3rem 0.75rem', background: '#f59e0b', color: 'white', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: '0.78rem', fontWeight: 600 }}>
                          📋 Copy Link
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </main>
      </div>
    </AppShell>
  );
}
