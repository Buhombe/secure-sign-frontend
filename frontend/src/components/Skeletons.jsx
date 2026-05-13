/**
 * Skeletons.jsx — HakikiSign Skeleton Loader Components
 *
 * Skeleton loaders prevent layout shift and convey structure during loading.
 * They match the actual content dimensions to avoid CLS (Cumulative Layout Shift).
 *
 * All skeletons use the same pulse animation and color tokens for visual consistency.
 */

import { memo } from 'react';

// ── Base Skeleton Block ────────────────────────────────────────────────────────
export const Skeleton = memo(function Skeleton({ width, height, radius = 6, style }) {
  return (
    <>
      <style>{`
        @keyframes skeletonPulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.4; }
        }
        .skeleton-pulse {
          animation: skeletonPulse 1.6s ease-in-out infinite;
          background: #E2E8F0;
        }
      `}</style>
      <div
        className="skeleton-pulse"
        style={{
          width,
          height,
          borderRadius: radius,
          flexShrink: 0,
          ...style,
        }}
      />
    </>
  );
});

// ── Stat Card Skeleton ─────────────────────────────────────────────────────────
export const StatCardSkeleton = memo(function StatCardSkeleton() {
  return (
    <div style={{
      background: 'white',
      borderRadius: 14,
      padding: '1.25rem 1.4rem',
      border: '1px solid #E2E8F0',
      boxShadow: '0 1px 4px rgba(0,0,0,0.04)',
      display: 'flex',
      alignItems: 'center',
      gap: '1rem',
    }}>
      <Skeleton width={44} height={44} radius={12} />
      <div>
        <Skeleton width={48} height={28} style={{ marginBottom: 8 }} />
        <Skeleton width={80} height={12} />
        <Skeleton width={60} height={10} style={{ marginTop: 6 }} />
      </div>
    </div>
  );
});

// ── Document Row Skeleton ──────────────────────────────────────────────────────
export const DocRowSkeleton = memo(function DocRowSkeleton({ index = 0 }) {
  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      padding: '0.9rem 1.25rem',
      borderBottom: '1px solid #F8FAFC',
      gap: '0.75rem',
      background: index % 2 === 0 ? 'white' : '#FAFBFC',
    }}>
      <Skeleton width={36} height={36} radius={9} />
      <div style={{ flex: 3 }}>
        <Skeleton width="70%" height={14} style={{ marginBottom: 6 }} />
        <Skeleton width="40%" height={11} />
      </div>
      <div style={{ flex: 1.5, display: 'flex', justifyContent: 'center' }}>
        <Skeleton width={70} height={22} radius={20} />
      </div>
      <div style={{ flex: 1.5, display: 'flex', justifyContent: 'center' }}>
        <Skeleton width={80} height={13} />
      </div>
      <div style={{ flex: 2, display: 'flex', justifyContent: 'flex-end', gap: '0.4rem' }}>
        <Skeleton width={52} height={28} radius={7} />
        <Skeleton width={52} height={28} radius={7} />
      </div>
    </div>
  );
});

// ── Document Table Skeleton (multiple rows) ────────────────────────────────────
export const DocumentTableSkeleton = memo(function DocumentTableSkeleton({ rows = 5 }) {
  return (
    <div>
      {Array.from({ length: rows }).map((_, i) => (
        <DocRowSkeleton key={i} index={i} />
      ))}
    </div>
  );
});

// ── Card Skeleton (mobile) ─────────────────────────────────────────────────────
export const DocCardSkeleton = memo(function DocCardSkeleton() {
  return (
    <div style={{
      background: 'white',
      borderRadius: 14,
      border: '1px solid #E2E8F0',
      padding: '1.1rem',
      boxShadow: '0 1px 3px rgba(0,0,0,0.04)',
      display: 'flex',
      flexDirection: 'column',
      gap: '0.75rem',
    }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: '0.75rem' }}>
        <Skeleton width={40} height={40} radius={10} />
        <div style={{ flex: 1 }}>
          <Skeleton width="75%" height={14} style={{ marginBottom: 8 }} />
          <Skeleton width="45%" height={11} />
        </div>
        <Skeleton width={65} height={22} radius={20} />
      </div>
      <div style={{ display: 'flex', gap: '0.4rem', paddingTop: '0.25rem', borderTop: '1px solid #F1F5F9' }}>
        <Skeleton width={52} height={28} radius={7} />
        <Skeleton width={52} height={28} radius={7} />
        <Skeleton width={52} height={28} radius={7} />
      </div>
    </div>
  );
});

// ── Audit Log Row Skeleton ────────────────────────────────────────────────────
export const AuditRowSkeleton = memo(function AuditRowSkeleton() {
  return (
    <div style={{
      display: 'flex',
      gap: '1rem',
      padding: '0.9rem 1.25rem',
      borderBottom: '1px solid #F8FAFC',
      alignItems: 'flex-start',
    }}>
      <Skeleton width={32} height={32} radius={8} />
      <div style={{ flex: 1 }}>
        <Skeleton width="60%" height={13} style={{ marginBottom: 6 }} />
        <Skeleton width="40%" height={11} />
      </div>
      <Skeleton width={80} height={11} />
    </div>
  );
});

// ── View Document Skeleton ────────────────────────────────────────────────────
export const ViewDocumentSkeleton = memo(function ViewDocumentSkeleton() {
  return (
    <div style={{ padding: '1.5rem', maxWidth: 800, margin: '0 auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', marginBottom: '2rem' }}>
        <Skeleton width={48} height={48} radius={12} />
        <div>
          <Skeleton width={200} height={20} style={{ marginBottom: 8 }} />
          <Skeleton width={120} height={13} />
        </div>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: '0.5rem' }}>
          <Skeleton width={80} height={36} radius={9} />
          <Skeleton width={80} height={36} radius={9} />
        </div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: '1.5rem' }}>
        <Skeleton width="100%" height={500} radius={12} />
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          {[1,2,3].map(i => (
            <div key={i} style={{ background: 'white', borderRadius: 12, border: '1px solid #E2E8F0', padding: '1rem' }}>
              <Skeleton width="60%" height={13} style={{ marginBottom: 8 }} />
              <Skeleton width="90%" height={11} style={{ marginBottom: 6 }} />
              <Skeleton width="70%" height={11} />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
});

// ── Settings Skeleton ─────────────────────────────────────────────────────────
export const SettingsSkeleton = memo(function SettingsSkeleton() {
  return (
    <div style={{ maxWidth: 640, margin: '0 auto', padding: '1.5rem' }}>
      <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1.5rem' }}>
        {[1,2,3].map(i => <Skeleton key={i} width={90} height={36} radius={9} />)}
      </div>
      {[1,2].map(i => (
        <div key={i} style={{ background: 'white', borderRadius: 16, border: '1px solid #E2E8F0', marginBottom: '1.25rem', overflow: 'hidden' }}>
          <div style={{ padding: '1.25rem 1.5rem', borderBottom: '1px solid #F1F5F9' }}>
            <Skeleton width={120} height={16} style={{ marginBottom: 8 }} />
            <Skeleton width={200} height={12} />
          </div>
          <div style={{ padding: '1.25rem 1.5rem', display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            {[1,2].map(j => (
              <div key={j}>
                <Skeleton width={80} height={12} style={{ marginBottom: 8 }} />
                <Skeleton width="100%" height={38} radius={9} />
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
});
