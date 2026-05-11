// /frontend/src/components/WorkflowTracker.jsx
// Drop-in component for ViewDocument.jsx
// Props: steps (array), currentStep (number), onRemind (fn), onVoid (fn), canEdit (bool)

import { useState } from 'react';

const SIGNER_STATUS = {
  pending:  { label: 'Pending',  color: '#d97706', bg: '#fef9c3', icon: '⏳' },
  viewed:   { label: 'Opened',   color: '#2563eb', bg: '#dbeafe', icon: '👁️' },
  signed:   { label: 'Signed',   color: '#16a34a', bg: '#dcfce7', icon: '✍️' },
  approved: { label: 'Approved', color: '#16a34a', bg: '#dcfce7', icon: '✓'  },
  declined: { label: 'Declined', color: '#dc2626', bg: '#fee2e2', icon: '✗'  },
};

export default function WorkflowTracker({ steps = [], currentStep = 0, onRemind, onVoid, canEdit = false }) {
  const [expanded, setExpanded]   = useState(currentStep - 1 >= 0 ? currentStep - 1 : 0);
  const [reminding, setReminding] = useState(null);
  const [voidConfirm, setVoidConfirm] = useState(false);
  const [voidReason,  setVoidReason]  = useState('');

  if (!steps.length) return null;

  const handleRemind = async (signerId, e) => {
    e.stopPropagation();
    if (!onRemind) return;
    setReminding(signerId);
    try { await onRemind(signerId); }
    finally { setReminding(null); }
  };

  return (
    <div style={{ fontFamily: 'system-ui,sans-serif' }}>

      {/* ── Step progress bar ── */}
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 16 }}>
        {steps.map((step, i) => {
          const done   = step.status === 'completed';
          const active = step.status === 'active';
          const last   = i === steps.length - 1;
          return (
            <div key={step.id} style={{ display: 'flex', alignItems: 'center', flex: 1 }}>
              {/* connector before */}
              {i > 0 && <div style={{ flex: 1, height: 2, background: done ? '#16a34a' : '#e5e7eb', transition: 'background .3s' }} />}

              {/* circle */}
              <button onClick={() => setExpanded(expanded === i ? -1 : i)} style={{
                width: 34, height: 34, borderRadius: '50%', border: '2px solid',
                borderColor: done ? '#16a34a' : active ? '#2563eb' : '#cbd5e1',
                background:  done ? '#16a34a' : active ? '#2563eb' : '#fff',
                color: (done || active) ? '#fff' : '#94a3b8',
                fontWeight: 700, fontSize: 13, cursor: 'pointer', flexShrink: 0,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                boxShadow: active ? '0 0 0 4px rgba(37,99,235,0.15)' : 'none',
                transition: 'all .2s',
              }}>
                {done ? '✓' : step.step_order}
              </button>

              {/* connector after */}
              {!last && <div style={{ flex: 1, height: 2, background: done ? '#16a34a' : '#e5e7eb', transition: 'background .3s' }} />}
            </div>
          );
        })}
      </div>

      {/* ── Step labels ── */}
      <div style={{ display: 'flex', marginBottom: 16 }}>
        {steps.map((step) => (
          <div key={step.id} style={{ flex: 1, textAlign: 'center', padding: '0 4px' }}>
            <div style={{ fontSize: 11, fontWeight: 600, color: step.status === 'active' ? '#2563eb' : '#94a3b8', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {step.name}
            </div>
            <div style={{ fontSize: 10, color: step.status === 'completed' ? '#16a34a' : step.status === 'active' ? '#2563eb' : '#cbd5e1' }}>
              {step.status === 'completed' ? 'Done' : step.status === 'active' ? 'Active' : 'Waiting'}
            </div>
          </div>
        ))}
      </div>

      {/* ── Expanded step detail ── */}
      {steps.map((step, i) => {
        if (expanded !== i) return null;
        const signers = step.signers || [];
        const borderColor = step.status === 'completed' ? '#16a34a' : step.status === 'active' ? '#2563eb' : '#e5e7eb';
        const bgColor     = step.status === 'completed' ? '#f0fdf4' : step.status === 'active' ? '#eff6ff' : '#f8fafc';

        return (
          <div key={step.id} style={{ border: `1.5px solid ${borderColor}`, borderRadius: 10, background: bgColor, padding: '14px 16px', marginBottom: 10 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
              <span style={{ fontWeight: 700, fontSize: 14, color: '#0f172a' }}>{step.name}</span>
              <span style={{ fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 12,
                background: borderColor, color: '#fff', opacity: 0.9 }}>
                {step.status === 'completed' ? 'Complete' : step.status === 'active' ? 'In Progress' : 'Waiting'}
              </span>
              {step.completed_at && (
                <span style={{ fontSize: 11, color: '#64748b', marginLeft: 'auto' }}>
                  {new Date(step.completed_at).toLocaleString()}
                </span>
              )}
            </div>

            {signers.length === 0 && (
              <p style={{ fontSize: 12, color: '#94a3b8', fontStyle: 'italic' }}>No signers assigned.</p>
            )}

            {signers.map(s => {
              const sc = SIGNER_STATUS[s.status] || SIGNER_STATUS.pending;
              const canRemind = canEdit && ['pending','viewed'].includes(s.status) && step.status === 'active';

              return (
                <div key={s.id} style={{
                  display: 'flex', alignItems: 'center', gap: 10,
                  padding: '9px 12px', background: '#fff',
                  borderRadius: 7, border: '1px solid #e5e7eb', marginBottom: 6,
                }}>
                  {/* avatar */}
                  <div style={{ width: 30, height: 30, borderRadius: '50%', background: sc.bg, color: sc.color, display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, fontSize: 12, flexShrink: 0 }}>
                    {(s.name || s.email)?.[0]?.toUpperCase() || '?'}
                  </div>

                  {/* info */}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: '#0f172a', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {s.name || s.email}
                    </div>
                    <div style={{ fontSize: 11, color: '#64748b' }}>{s.email}</div>
                  </div>

                  {/* role */}
                  <span style={{ fontSize: 10, fontWeight: 600, padding: '2px 7px', borderRadius: 10, background: '#f1f5f9', color: '#475569', flexShrink: 0 }}>
                    {s.role}
                  </span>

                  {/* status */}
                  <span style={{ fontSize: 11, fontWeight: 600, padding: '3px 9px', borderRadius: 20, background: sc.bg, color: sc.color, flexShrink: 0 }}>
                    {sc.icon} {sc.label}
                  </span>

                  {/* signed at */}
                  {s.signed_at && (
                    <span style={{ fontSize: 10, color: '#94a3b8', flexShrink: 0 }}>
                      {new Date(s.signed_at).toLocaleString()}
                    </span>
                  )}

                  {/* remind */}
                  {canRemind && (
                    <button onClick={(e) => handleRemind(s.id, e)} disabled={reminding === s.id}
                      style={{ background: 'none', border: '1px solid #e5e7eb', borderRadius: 5, padding: '3px 10px', fontSize: 11, color: '#64748b', cursor: 'pointer', flexShrink: 0 }}>
                      {reminding === s.id ? '...' : '🔔 Remind'}
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        );
      })}

      {/* ── Void confirm ── */}
      {canEdit && onVoid && (
        <div style={{ marginTop: 16 }}>
          {!voidConfirm ? (
            <button onClick={() => setVoidConfirm(true)}
              style={{ background: 'none', border: '1px solid #fecaca', borderRadius: 7, padding: '6px 14px', fontSize: 12, color: '#dc2626', cursor: 'pointer' }}>
              Void Document
            </button>
          ) : (
            <div style={{ background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 9, padding: '14px 16px' }}>
              <p style={{ fontSize: 13, fontWeight: 600, color: '#991b1b', marginBottom: 8 }}>Void this document?</p>
              <input value={voidReason} onChange={e => setVoidReason(e.target.value)}
                placeholder="Reason (optional)"
                style={{ width: '100%', padding: '7px 10px', border: '1px solid #fecaca', borderRadius: 6, fontSize: 13, marginBottom: 10, boxSizing: 'border-box', outline: 'none' }} />
              <div style={{ display: 'flex', gap: 8 }}>
                <button onClick={() => { onVoid(voidReason); setVoidConfirm(false); }}
                  style={{ background: '#dc2626', color: '#fff', border: 'none', borderRadius: 6, padding: '7px 16px', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>
                  Confirm Void
                </button>
                <button onClick={() => setVoidConfirm(false)}
                  style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 6, padding: '7px 16px', fontSize: 13, cursor: 'pointer' }}>
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}