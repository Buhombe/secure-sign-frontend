import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../services/api';
import AppShell from '../components/AppShell';

export default function AuditLog() {
  const navigate = useNavigate();
  const [logs, setLogs] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.get('/audit').then(({ data }) => setLogs(data.logs)).catch(console.error).finally(() => setLoading(false));
  }, []);

  const actionColors = { SIGN: ['#dcfce7','#16a34a'], UPLOAD: ['#eff6ff','#2563eb'], VIEW: ['#f5f3ff','#7c3aed'], LOGIN: ['#fef9c3','#ca8a04'], SIGNUP: ['#fce7f3','#db2777'] };

  return (
    <AppShell>
      <div style={{ flex: 1 }}>
        <header style={{ background: 'white', borderBottom: '1px solid #e5e7eb', padding: '1rem 1.5rem' }}>
          <h1 style={{ fontSize: '1.1rem', fontWeight: 700, color: '#0f172a' }}>Audit Reports</h1>
        </header>
        <main style={{ padding: 'clamp(1rem, 3vw, 2rem)' }}>
          <div style={{ background: 'white', borderRadius: 14, border: '1px solid #e5e7eb', overflow: 'hidden' }}>
            <div style={{ padding: '1rem 1.5rem', borderBottom: '1px solid #f1f5f9', fontSize: '0.8rem', fontWeight: 600, color: '#64748b' }}>
              Showing last {logs.length} activities
            </div>
            {loading ? (
              <div style={{ padding: '3rem', textAlign: 'center', color: '#94a3b8' }}>Loading...</div>
            ) : logs.length === 0 ? (
              <div style={{ padding: '3rem', textAlign: 'center', color: '#94a3b8' }}>No activity yet.</div>
            ) : logs.map((log, i) => {
              const [bg, fg] = actionColors[log.action] || ['#f1f5f9','#374151'];
              return (
                <div key={log.id} style={{ display: 'flex', alignItems: 'center', gap: '1rem', padding: '0.85rem 1.5rem', borderBottom: '1px solid #f8fafc', background: i % 2 === 0 ? 'white' : '#fafafa', flexWrap: 'wrap' }}>
                  <span style={{ padding: '0.2rem 0.65rem', borderRadius: 20, fontSize: '0.72rem', fontWeight: 700, background: bg, color: fg, whiteSpace: 'nowrap' }}>
                    {log.action}
                  </span>
                  <span style={{ flex: 1, fontSize: '0.85rem', color: '#374151', minWidth: 120 }}>
                    {log.document_name || '—'}
                  </span>
                  <span style={{ fontSize: '0.75rem', color: '#94a3b8', whiteSpace: 'nowrap' }}>
                    {new Date(log.timestamp).toLocaleString()}
                  </span>
                  <span style={{ fontSize: '0.72rem', color: '#cbd5e1', whiteSpace: 'nowrap' }}>
                    {log.ip_address}
                  </span>
                </div>
              );
            })}
          </div>
        </main>
      </div>
    </AppShell>
  );
}
