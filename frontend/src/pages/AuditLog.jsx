import { useEffect, useState } from 'react';
import api from '../services/api';
import AppShell from '../components/AppShell';

const ACTION_META = {
  SIGN:                    { label: 'Signed',           bg: '#dcfce7', fg: '#15803d', icon: '✍️' },
  UPLOAD:                  { label: 'Uploaded',         bg: '#eff6ff', fg: '#1d4ed8', icon: '⬆️' },
  VIEW:                    { label: 'Viewed',           bg: '#f5f3ff', fg: '#6d28d9', icon: '👁️' },
  DOWNLOAD:                { label: 'Downloaded',       bg: '#fef3c7', fg: '#92400e', icon: '⬇️' },
  DOWNLOAD_PUBLIC:         { label: 'Downloaded',       bg: '#fef3c7', fg: '#92400e', icon: '⬇️' },
  LOGIN:                   { label: 'Login',            bg: '#fef9c3', fg: '#854d0e', icon: '🔑' },
  SIGNUP:                  { label: 'Signup',           bg: '#fce7f3', fg: '#9d174d', icon: '👤' },
  LOGOUT:                  { label: 'Logout',           bg: '#f1f5f9', fg: '#475569', icon: '🚪' },
  EMAIL_VERIFIED:          { label: 'Email verified',  bg: '#dcfce7', fg: '#15803d', icon: '✅' },
  MFA_ENABLED:             { label: 'MFA enabled',     bg: '#dcfce7', fg: '#15803d', icon: '🔒' },
  MFA_AUTH:                { label: 'MFA verified',    bg: '#eff6ff', fg: '#1d4ed8', icon: '🔒' },
  PASSWORD_RESET_COMPLETE: { label: 'Password reset',  bg: '#fef9c3', fg: '#854d0e', icon: '🔑' },
  ACCOUNT_LOCKED:          { label: 'Account locked',  bg: '#fee2e2', fg: '#b91c1c', icon: '⛔' },
  VERIFY:                  { label: 'Verified',        bg: '#dcfce7', fg: '#15803d', icon: '✅' },
};

function getMeta(action) {
  return ACTION_META[action] || { label: action, bg: '#f1f5f9', fg: '#374151', icon: '📋' };
}

function timeAgo(dateStr) {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  const hrs  = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);
  if (mins < 1)  return 'just now';
  if (mins < 60) return `${mins}m ago`;
  if (hrs < 24)  return `${hrs}h ago`;
  if (days < 7)  return `${days}d ago`;
  return new Date(dateStr).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

export default function AuditLog() {
  const [logs, setLogs]         = useState([]);
  const [loading, setLoading]   = useState(true);
  const [filter, setFilter]     = useState('all');
  const [search, setSearch]     = useState('');

  useEffect(() => {
    api.get('/audit?limit=100')
      .then(({ data }) => setLogs(data.logs))
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  const filters = [
    { key: 'all',      label: 'All' },
    { key: 'SIGN',     label: 'Signed' },
    { key: 'UPLOAD',   label: 'Uploads' },
    { key: 'LOGIN',    label: 'Logins' },
  ];

  const filtered = logs.filter(l => {
    const matchFilter = filter === 'all' || l.action === filter;
    const matchSearch = !search ||
      (l.document_name || '').toLowerCase().includes(search.toLowerCase()) ||
      l.action.toLowerCase().includes(search.toLowerCase());
    return matchFilter && matchSearch;
  });

  // Stats
  const signs   = logs.filter(l => l.action === 'SIGN').length;
  const uploads = logs.filter(l => l.action === 'UPLOAD').length;
  const today   = logs.filter(l => {
    return new Date(l.timestamp).toDateString() === new Date().toDateString();
  }).length;

  return (
    <AppShell>
      <div style={{ flex: 1 }}>
        <header style={{ background: 'white', borderBottom: '1px solid #e5e7eb', padding: '1rem 1.5rem' }}>
          <h1 style={{ fontSize: '1.1rem', fontWeight: 700, color: '#0f172a', margin: 0 }}>Audit Trail</h1>
        </header>

        <main style={{ padding: 'clamp(1rem, 3vw, 2rem)', maxWidth: 900, margin: '0 auto' }}>

          {/* Stats */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 12, marginBottom: '1.5rem' }}>
            {[
              { num: logs.length, label: 'Total events',  color: '#2563eb' },
              { num: uploads,     label: 'Documents',     color: '#7c3aed' },
              { num: signs,       label: 'Signatures',    color: '#16a34a' },
              { num: today,       label: 'Today',         color: '#d97706' },
            ].map(({ num, label, color }) => (
              <div key={label} style={{ background: 'white', borderRadius: 12, padding: '1rem 1.25rem', border: '1px solid #e5e7eb' }}>
                <div style={{ fontSize: '1.8rem', fontWeight: 800, color, lineHeight: 1 }}>{num}</div>
                <div style={{ fontSize: '0.78rem', color: '#64748b', marginTop: 4 }}>{label}</div>
              </div>
            ))}
          </div>

          {/* Filters + Search */}
          <div style={{ display: 'flex', gap: '0.75rem', marginBottom: '1rem', flexWrap: 'wrap', alignItems: 'center' }}>
            <div style={{ display: 'flex', gap: 4 }}>
              {filters.map(f => (
                <button key={f.key} onClick={() => setFilter(f.key)}
                  style={{ padding: '0.3rem 0.8rem', borderRadius: 20, border: '1px solid', cursor: 'pointer', fontSize: '0.78rem', fontWeight: filter === f.key ? 700 : 500,
                    borderColor: filter === f.key ? '#bfdbfe' : '#e5e7eb',
                    background: filter === f.key ? '#eff6ff' : 'white',
                    color: filter === f.key ? '#2563eb' : '#64748b' }}>
                  {f.label}
                </button>
              ))}
            </div>
            <input
              value={search} onChange={e => setSearch(e.target.value)}
              placeholder="Search by document or action..."
              style={{ flex: 1, minWidth: 180, padding: '0.4rem 0.8rem', borderRadius: 8, border: '1px solid #e2e8f0', fontSize: '0.85rem', outline: 'none', background: '#f8fafc' }}
            />
          </div>

          {/* Timeline */}
          <div style={{ background: 'white', borderRadius: 14, border: '1px solid #e5e7eb', overflow: 'hidden' }}>
            <div style={{ padding: '0.75rem 1.5rem', borderBottom: '1px solid #f1f5f9', fontSize: '0.78rem', fontWeight: 600, color: '#94a3b8' }}>
              {filtered.length} event{filtered.length !== 1 ? 's' : ''}
            </div>

            {loading ? (
              <div style={{ padding: '3rem', textAlign: 'center', color: '#94a3b8' }}>Loading...</div>
            ) : filtered.length === 0 ? (
              <div style={{ padding: '3rem', textAlign: 'center', color: '#94a3b8' }}>No events found.</div>
            ) : (
              <div style={{ position: 'relative' }}>
                {filtered.map((log, i) => {
                  const meta = getMeta(log.action);
                  return (
                    <div key={log.id} style={{ display: 'flex', gap: '1rem', padding: '0.85rem 1.5rem', borderBottom: i < filtered.length - 1 ? '1px solid #f8fafc' : 'none', alignItems: 'flex-start' }}>

                      {/* Icon */}
                      <div style={{ width: 34, height: 34, borderRadius: '50%', background: meta.bg, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.9rem', flexShrink: 0, marginTop: 2 }}>
                        {meta.icon}
                      </div>

                      {/* Content */}
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
                          <span style={{ padding: '0.15rem 0.6rem', borderRadius: 20, fontSize: '0.7rem', fontWeight: 700, background: meta.bg, color: meta.fg, whiteSpace: 'nowrap' }}>
                            {meta.label}
                          </span>
                          {log.document_name && (
                            <span style={{ fontSize: '0.85rem', color: '#0f172a', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 300 }}>
                              {log.document_name}
                            </span>
                          )}
                        </div>
                        {log.ip_address && (
                          <div style={{ fontSize: '0.72rem', color: '#cbd5e1', marginTop: 3 }}>
                            IP: {log.ip_address}
                          </div>
                        )}
                      </div>

                      {/* Time */}
                      <div style={{ fontSize: '0.75rem', color: '#94a3b8', whiteSpace: 'nowrap', flexShrink: 0, marginTop: 4 }}>
                        <div>{timeAgo(log.timestamp)}</div>
                        <div style={{ fontSize: '0.7rem', color: '#cbd5e1', marginTop: 2 }}>
                          {new Date(log.timestamp).toLocaleString('en-GB', { hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'short' })}
                        </div>
                      </div>

                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </main>
      </div>
    </AppShell>
  );
}
