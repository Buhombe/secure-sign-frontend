import React from 'react';

const STATUS_CONFIG = {
  signed:    { color: '#16a34a', bg: '#dcfce7', border: '#86efac', icon: '✓', label: 'Signed' },
  completed: { color: '#16a34a', bg: '#dcfce7', border: '#86efac', icon: '✓', label: 'Completed' },
  pending:   { color: '#d97706', bg: '#fef9c3', border: '#fde68a', icon: '◷', label: 'Waiting' },
  sent:      { color: '#2563eb', bg: '#dbeafe', border: '#93c5fd', icon: '→', label: 'Sent' },
  declined:  { color: '#dc2626', bg: '#fee2e2', border: '#fca5a5', icon: '✕', label: 'Declined' },
  default:   { color: '#64748b', bg: '#f1f5f9', border: '#cbd5e1', icon: '○', label: 'Not Started' },
};

function getStatus(s) {
  return STATUS_CONFIG[s] || STATUS_CONFIG.default;
}

export default function WorkflowTracker({ signers = [] }) {
  if (!signers || signers.length === 0) return null;

  const totalSigned = signers.filter(s => s.status === 'signed' || s.status === 'completed').length;
  const progress = Math.round((totalSigned / signers.length) * 100);

  return (
    <div style={{ fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif' }}>

      {/* Summary card */}
      <div style={{
        background: 'white', border: '1px solid #e2e8f0', borderRadius: 12,
        padding: '1.25rem 1.5rem', marginBottom: '1rem',
        boxShadow: '0 1px 3px rgba(0,0,0,0.06)'
      }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.75rem' }}>
          <div>
            <div style={{ fontSize: '0.75rem', fontWeight: 600, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              Signing Progress
            </div>
            <div style={{ fontSize: '1.4rem', fontWeight: 700, color: '#0f172a', marginTop: 2 }}>
              {totalSigned} of {signers.length} signed
            </div>
          </div>
          <div style={{
            width: 52, height: 52, borderRadius: '50%',
            background: progress === 100 ? '#dcfce7' : '#f1f5f9',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: progress === 100 ? '1.3rem' : '0.95rem',
            fontWeight: 800,
            color: progress === 100 ? '#16a34a' : '#475569'
          }}>
            {progress === 100 ? '✓' : `${progress}%`}
          </div>
        </div>
        <div style={{ height: 6, background: '#e2e8f0', borderRadius: 99, overflow: 'hidden' }}>
          <div style={{
            height: '100%', borderRadius: 99,
            background: progress === 100 ? '#16a34a' : '#2563eb',
            width: `${progress}%`,
            transition: 'width 0.5s ease'
          }} />
        </div>
      </div>

      {/* Recipients list */}
      <div style={{ background: 'white', border: '1px solid #e2e8f0', borderRadius: 12, overflow: 'hidden', boxShadow: '0 1px 3px rgba(0,0,0,0.06)' }}>
        <div style={{ padding: '0.75rem 1.5rem', borderBottom: '1px solid #f1f5f9', background: '#f8fafc' }}>
          <span style={{ fontSize: '0.72rem', fontWeight: 700, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
            Recipients ({signers.length})
          </span>
        </div>

        {signers.map((signer, i) => {
          const st = getStatus(signer.status);
          const isLast = i === signers.length - 1;
          return (
            <div key={signer.id || i}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', padding: '1rem 1.5rem' }}>
                {/* Avatar with step number */}
                <div style={{ position: 'relative', flexShrink: 0 }}>
                  <div style={{
                    width: 42, height: 42, borderRadius: '50%',
                    background: st.bg, border: `2px solid ${st.border}`,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontSize: '1rem', fontWeight: 700, color: st.color,
                  }}>
                    {signer.status === 'signed' || signer.status === 'completed' ? '✓' : i + 1}
                  </div>
                </div>

                {/* Name + email + time */}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: '0.875rem', fontWeight: 600, color: '#0f172a', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {signer.name || signer.email}
                  </div>
                  {signer.name && (
                    <div style={{ fontSize: '0.75rem', color: '#64748b', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {signer.email}
                    </div>
                  )}
                  {signer.signed_at && (
                    <div style={{ fontSize: '0.72rem', color: '#16a34a', marginTop: 2, display: 'flex', alignItems: 'center', gap: 4 }}>
                      <span>✓</span>
                      <span>Signed {new Date(signer.signed_at).toLocaleString()}</span>
                    </div>
                  )}
                  {!signer.signed_at && signer.status === 'pending' && (
                    <div style={{ fontSize: '0.72rem', color: '#d97706', marginTop: 2 }}>
                      Email sent — awaiting signature
                    </div>
                  )}
                  {!signer.signed_at && signer.status !== 'pending' && (
                    <div style={{ fontSize: '0.72rem', color: '#94a3b8', marginTop: 2 }}>
                      Not yet notified
                    </div>
                  )}
                </div>

                {/* Status pill */}
                <div style={{
                  padding: '0.2rem 0.65rem', borderRadius: 99, flexShrink: 0,
                  fontSize: '0.7rem', fontWeight: 700,
                  background: st.bg, color: st.color, border: `1px solid ${st.border}`
                }}>
                  {st.label}
                </div>
              </div>

              {!isLast && (
                <div style={{ paddingLeft: '2.65rem' }}>
                  <div style={{ width: 2, height: 16, background: '#e2e8f0', marginLeft: 20 }} />
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}