import React from 'react';

export default function WorkflowTracker({ signers = [] }) {
  if (!signers || signers.length === 0) return null;
  return (
    <div style={{ padding: '1rem', background: '#f8fafc', borderRadius: 8, border: '1px solid #e2e8f0' }}>
      <div style={{ fontSize: '0.75rem', fontWeight: 700, color: '#94a3b8', textTransform: 'uppercase', marginBottom: '0.75rem' }}>
        Signing Progress
      </div>
      {signers.map((s, i) => (
        <div key={s.id || i} style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '0.5rem' }}>
          <div style={{ width: 28, height: 28, borderRadius: '50%', flexShrink: 0, background: s.status === 'signed' ? '#16a34a' : '#e2e8f0', color: 'white', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.75rem', fontWeight: 700 }}>
            {s.status === 'signed' ? '✓' : i + 1}
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: '0.82rem', fontWeight: 600, color: '#0f172a' }}>{s.email}</div>
            <div style={{ fontSize: '0.72rem', color: s.status === 'signed' ? '#16a34a' : '#94a3b8' }}>
              {s.status === 'signed' ? 'Signed' : s.status === 'pending' ? 'Waiting' : 'Not yet notified'}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
