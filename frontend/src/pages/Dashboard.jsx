// Dashboard.jsx — HakikiSign Enterprise Dashboard
// PAGINATION UPGRADE: Replaces the hardcoded .slice(0,20) with full
// cursor-based pagination, server-side stats, load-more UX, skeleton
// loading states, error recovery, and "Showing X of Y" indicator.
//
// KEY CHANGES vs. previous implementation:
//   BEFORE: api.get('/documents') → fetches ALL docs → .slice(0,20) on frontend
//   AFTER:  Cursor pagination via useDocumentPagination hook
//           Stats via separate /documents/stats endpoint
//           Load-more button (compatible with future infinite-scroll)
//           Full empty/error/loading states
//           No UI freezing, no race conditions, no duplicate fetches

import { useEffect, useState, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { getStatusStyle } from '../services/documentApi';
import { useDocumentStats, useInfiniteDocuments } from '../lib/queries';
import AppShell from '../components/AppShell';
import { StatCardSkeleton, DocumentTableSkeleton } from '../components/Skeletons';

// ── Debounce hook ─────────────────────────────────────────────────────────────
// Prevents a new API call on every keystroke in the search box.
// 350ms delay: fast enough to feel responsive, slow enough to batch keystrokes.
function useDebounced(value, delay = 350) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(t);
  }, [value, delay]);
  return debounced;
}

// ── Status Badge ──────────────────────────────────────────────────────────────
function StatusBadge({ status }) {
  const st = getStatusStyle(status);
  const dots = {
    completed: '#16A34A', signed: '#16A34A', pending: '#D97706',
    in_progress: '#2563EB', voided: '#DC2626', expired: '#9333EA',
    draft: '#64748B', declined: '#B45309',
  };
  const dot = dots[status] || '#64748B';
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 5,
      padding: '3px 10px', borderRadius: 20,
      fontSize: '0.72rem', fontWeight: 600,
      background: st.bg, color: st.color,
    }}>
      <span style={{ width: 5, height: 5, borderRadius: '50%', background: dot, flexShrink: 0 }} />
      {st.label}
    </span>
  );
}

// ── Stat Card ─────────────────────────────────────────────────────────────────
function StatCard({ num, label, sub, icon, iconBg, iconColor, loading }) {
  return (
    <div style={{
      background: 'white', borderRadius: 14, padding: '1.25rem 1.4rem',
      border: '1px solid #E2E8F0',
      boxShadow: '0 1px 4px rgba(0,0,0,0.04)',
      display: 'flex', alignItems: 'center', gap: '1rem',
    }}>
      <div style={{
        width: 44, height: 44, borderRadius: 12, flexShrink: 0,
        background: iconBg, color: iconColor,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>
        {icon}
      </div>
      <div>
        {loading ? (
          <>
            <div className="pulse" style={{ width: 48, height: 28, background: '#E2E8F0', borderRadius: 6, marginBottom: 6 }} />
            <div className="pulse" style={{ width: 70, height: 12, background: '#E2E8F0', borderRadius: 4 }} />
          </>
        ) : (
          <>
            <div style={{ fontSize: 'clamp(1.5rem, 3vw, 2rem)', fontWeight: 800, color: '#0F172A', lineHeight: 1.1 }}>
              {num?.toLocaleString() ?? '—'}
            </div>
            <div style={{ fontSize: '0.84rem', fontWeight: 600, color: '#374151', marginTop: 1 }}>{label}</div>
            <div style={{ fontSize: '0.72rem', color: '#94A3B8', marginTop: 2 }}>{sub}</div>
          </>
        )}
      </div>
    </div>
  );
}

// ── Actions Menu ──────────────────────────────────────────────────────────────
function ActionsMenu({ doc, navigate }) {
  const [open, setOpen] = useState(false);
  const isDone     = ['completed', 'signed'].includes(doc.status);
  const isTerminal = ['voided', 'declined'].includes(doc.status);
  const items = [
    { label: 'View',         icon: '👁',  action: () => navigate(`/document/${doc.id}`) },
    ...(!isDone && !isTerminal ? [{ label: 'Sign',         icon: '✍️', action: () => navigate(`/sign/${doc.id}`) }] : []),
    ...(!isDone && !isTerminal ? [{ label: 'Place Fields', icon: '📋', action: () => navigate(`/place-fields/${doc.id}`) }] : []),
    { label: 'Audit Trail',  icon: '📊', action: () => navigate(`/audit?doc=${doc.id}`) },
  ];

  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    document.addEventListener('click', close, { once: true });
    return () => document.removeEventListener('click', close);
  }, [open]);

  return (
    <div style={{ position: 'relative' }} onClick={e => e.stopPropagation()}>
      <button onClick={() => setOpen(o => !o)}
        style={{
          background: 'white', border: '1px solid #E2E8F0', borderRadius: 7,
          padding: '0.3rem 0.55rem', cursor: 'pointer', color: '#64748B',
          fontSize: '1rem', lineHeight: 1, display: 'flex', alignItems: 'center',
          transition: 'all 0.15s ease',
        }}
        onMouseEnter={e => e.currentTarget.style.background = '#F8FAFC'}
        onMouseLeave={e => e.currentTarget.style.background = 'white'}
      >
        ···
      </button>
      {open && (
        <div style={{
          position: 'absolute', right: 0, top: '110%', zIndex: 50,
          background: 'white', borderRadius: 10, border: '1px solid #E2E8F0',
          boxShadow: '0 8px 24px rgba(0,0,0,0.09)', padding: '0.35rem',
          minWidth: 160,
        }} className="fade-in">
          {items.map(item => (
            <button key={item.label} onClick={() => { item.action(); setOpen(false); }}
              style={{
                display: 'flex', alignItems: 'center', gap: '0.65rem',
                width: '100%', padding: '0.55rem 0.8rem',
                background: 'transparent', border: 'none', borderRadius: 7,
                fontSize: '0.83rem', color: '#0F172A', cursor: 'pointer', textAlign: 'left',
                transition: 'background 0.1s',
              }}
              onMouseEnter={e => e.currentTarget.style.background = '#F1F5F9'}
              onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
            >
              <span>{item.icon}</span> {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Skeleton Row ──────────────────────────────────────────────────────────────
function SkeletonRow() {
  return (
    <div className="dt-row" style={{ background: 'white', pointerEvents: 'none' }}>
      <div className="dt-col-name">
        <div className="pulse" style={{ width: 36, height: 36, borderRadius: 9, background: '#EEF2FF', flexShrink: 0 }} />
        <div className="pulse" style={{ width: '60%', height: 14, background: '#E2E8F0', borderRadius: 4 }} />
      </div>
      <div className="dt-col-status">
        <div className="pulse" style={{ width: 72, height: 22, background: '#E2E8F0', borderRadius: 12 }} />
      </div>
      <div className="dt-col-date">
        <div className="pulse" style={{ width: 80, height: 14, background: '#E2E8F0', borderRadius: 4, margin: '0 auto' }} />
      </div>
      <div className="dt-col-action">
        <div className="pulse" style={{ width: 48, height: 28, background: '#E2E8F0', borderRadius: 7 }} />
      </div>
    </div>
  );
}

// ── Empty State ───────────────────────────────────────────────────────────────
function EmptyState({ search, statusFilter, navigate }) {
  const hasFilters = search || statusFilter !== 'all';
  return (
    <div style={{ padding: '3.5rem 2rem', textAlign: 'center' }}>
      <div style={{
        width: 60, height: 60, borderRadius: '50%',
        background: '#F1F5F9', margin: '0 auto 1rem',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>
        <svg width="26" height="26" fill="none" viewBox="0 0 24 24" stroke="#94A3B8" strokeWidth="1.5">
          <path strokeLinecap="round" strokeLinejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/>
        </svg>
      </div>
      <div style={{ fontWeight: 600, color: '#374151', marginBottom: '0.4rem' }}>
        {hasFilters ? 'No results found' : 'No documents yet'}
      </div>
      <div style={{ fontSize: '0.84rem', color: '#94A3B8', marginBottom: '1.25rem' }}>
        {hasFilters
          ? 'Try adjusting your filters or search term.'
          : 'Upload your first document to get started.'}
      </div>
      {!hasFilters && (
        <button onClick={() => navigate('/upload')}
          style={{ padding: '0.55rem 1.2rem', background: '#2563EB', color: 'white', border: 'none', borderRadius: 9, fontWeight: 600, fontSize: '0.875rem', cursor: 'pointer' }}>
          Upload Document
        </button>
      )}
    </div>
  );
}

// ── Error State ───────────────────────────────────────────────────────────────
function ErrorState({ error, onRetry }) {
  const isAuth = error?.type === 'auth';
  return (
    <div style={{ padding: '3rem 2rem', textAlign: 'center' }}>
      <div style={{
        width: 52, height: 52, borderRadius: '50%',
        background: '#FFF1F2', margin: '0 auto 1rem',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>
        <svg width="22" height="22" fill="none" viewBox="0 0 24 24" stroke="#F43F5E" strokeWidth="2">
          <circle cx="12" cy="12" r="10"/>
          <path strokeLinecap="round" d="M12 8v4m0 4h.01"/>
        </svg>
      </div>
      <div style={{ fontWeight: 600, color: '#374151', marginBottom: '0.35rem' }}>
        {isAuth ? 'Session expired' : 'Failed to load documents'}
      </div>
      <div style={{ fontSize: '0.84rem', color: '#94A3B8', marginBottom: '1.25rem' }}>
        {error?.message || 'Something went wrong. Please try again.'}
      </div>
      {error?.retryable && (
        <button onClick={onRetry}
          style={{ padding: '0.5rem 1.2rem', background: '#2563EB', color: 'white', border: 'none', borderRadius: 9, fontWeight: 600, fontSize: '0.85rem', cursor: 'pointer' }}>
          Try again
        </button>
      )}
    </div>
  );
}

// ── Document Row ──────────────────────────────────────────────────────────────
function DocRow({ doc, index, navigate }) {
  const name = doc.original_name || doc.display_title || 'Untitled';
  return (
    <div className="dt-row" style={{ background: index % 2 === 0 ? 'white' : '#FAFBFC' }}>
      <div className="dt-col-name">
        <div style={{
          width: 36, height: 36, borderRadius: 9, background: '#EFF6FF',
          display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
        }}>
          <svg width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="#2563EB" strokeWidth="1.8">
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/>
          </svg>
        </div>
        <span style={{ fontWeight: 500, color: '#1E293B', fontSize: '0.875rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 280 }}>
          {name}
        </span>
      </div>

      <div className="dt-col-status">
        <StatusBadge status={doc.status} />
      </div>

      <div className="dt-col-date">
        {new Date(doc.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}
      </div>

      <div className="dt-col-action">
        <button onClick={() => navigate(`/document/${doc.id}`)}
          style={{
            padding: '0.33rem 0.8rem', background: 'white', border: '1px solid #BFDBFE',
            borderRadius: 7, cursor: 'pointer', fontWeight: 600, fontSize: '0.78rem', color: '#2563EB',
            transition: 'all 0.15s',
          }}
          onMouseEnter={e => { e.currentTarget.style.background = '#EFF6FF'; }}
          onMouseLeave={e => { e.currentTarget.style.background = 'white'; }}
        >
          View
        </button>
        <ActionsMenu doc={doc} navigate={navigate} />
      </div>
    </div>
  );
}

// ── Main Dashboard ────────────────────────────────────────────────────────────
export default function Dashboard() {
  const { user }   = useAuth();
  const navigate   = useNavigate();

  // ── Filter / sort / search state ───────────────────────────────────────────
  const [filter,     setFilter]     = useState('all');
  const [sortField,  setSortField]  = useState('created_at');
  const [sortDir,    setSortDir]    = useState('desc');
  const [searchRaw,  setSearchRaw]  = useState('');
  const search = useDebounced(searchRaw, 350);

  // ── Stats — TanStack Query (cached, background-refreshed) ────────────────
  const { data: stats, isLoading: statsLoading } = useDocumentStats();

  // ── Infinite paginated documents — TanStack Query ─────────────────────────
  const {
    data: infiniteData,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage: loadingMore,
    isLoading: loading,
    isError,
    error,
    refetch: retry,
  } = useInfiniteDocuments({
    status: filter,
    search,
    sort:   sortField,
    dir:    sortDir,
    limit:  25,
  });

  // Flatten all pages into a single documents array
  const documents = infiniteData?.pages?.flatMap(p => p.documents) ?? [];
  const total = infiniteData?.pages?.[0]?.total ?? 0;
  const loadedCount = documents.length;
  const hasMore = hasNextPage ?? false;
  const loadMore = fetchNextPage;

  // ── Filter definitions ─────────────────────────────────────────────────────
  const FILTERS = [
    { key: 'all',         label: 'All' },
    { key: 'pending',     label: 'Pending' },
    { key: 'in_progress', label: 'In Progress' },
    { key: 'signed',      label: 'Completed' },
    { key: 'declined',    label: 'Declined' },
    { key: 'voided',      label: 'Voided' },
  ];

  const displayName = user?.name || user?.email?.split('@')[0] || 'there';

  // ── Sort toggle ────────────────────────────────────────────────────────────
  const toggleSort = (field) => {
    if (sortField === field) {
      setSortDir(d => d === 'desc' ? 'asc' : 'desc');
    } else {
      setSortField(field);
      setSortDir('desc');
    }
  };

  const SortArrow = ({ field }) => {
    if (sortField !== field) return <span style={{ color: '#CBD5E1', marginLeft: 3 }}>↕</span>;
    return <span style={{ color: '#2563EB', marginLeft: 3 }}>{sortDir === 'desc' ? '↓' : '↑'}</span>;
  };

  return (
    <AppShell>
      <style>{`
        .dt-head { display: flex; padding: 0.6rem 1.25rem; }
        .dt-row  { display: flex; align-items: center; padding: 0.9rem 1.25rem; gap: 0.5rem; border-bottom: 1px solid #F8FAFC; transition: background 0.12s; }
        .dt-row:hover { background: #FAFAFA !important; }
        .dt-row:last-child { border-bottom: none; }
        .dt-col-name   { flex: 3; display: flex; align-items: center; gap: 0.75rem; min-width: 0; }
        .dt-col-status { flex: 1.8; display: flex; justify-content: center; }
        .dt-col-date   { flex: 1.8; text-align: center; color: #64748B; font-size: 0.82rem; }
        .dt-col-action { flex: 1; display: flex; justify-content: flex-end; gap: 0.4rem; }
        .pulse { animation: pulse 1.5s ease-in-out infinite; }
        @keyframes pulse { 0%,100% { opacity:1 } 50% { opacity:0.45 } }
        .fade-in { animation: fadeIn 0.2s ease; }
        @keyframes fadeIn { from { opacity:0; transform:translateY(4px) } to { opacity:1; transform:none } }
        @media (max-width: 640px) {
          .dt-head { display: none !important; }
          .dt-row  { flex-direction: column; align-items: flex-start; padding: 1rem; gap: 0.6rem; }
          .dt-col-name   { width: 100%; }
          .dt-col-status { justify-content: flex-start; }
          .dt-col-date   { text-align: left; }
          .dt-col-action { width: 100%; justify-content: flex-start; }
        }
      `}</style>

      <div className="fade-in" style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
        <main style={{ flex: 1, padding: 'clamp(1.25rem, 4vw, 2rem) clamp(1rem, 4vw, 2rem)', overflowX: 'hidden' }}>

          {/* ── Welcome ─────────────────────────────────────────────────────── */}
          <div style={{ marginBottom: '1.75rem' }}>
            <h1 style={{ fontSize: 'clamp(1.2rem, 3.5vw, 1.6rem)', fontWeight: 800, color: '#0F172A', marginBottom: '0.3rem', letterSpacing: '-0.02em' }}>
              Welcome back, {displayName} 👋
            </h1>
            <p style={{ fontSize: '0.9rem', color: '#64748B', fontWeight: 400 }}>
              Here's a summary of your signing activity.
            </p>
          </div>

          {/* ── Stats ───────────────────────────────────────────────────────── */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '1rem', marginBottom: '2rem' }}>
            <StatCard
              loading={statsLoading}
              num={stats?.pending} label="Pending" sub="Awaiting action"
              iconBg="#FEF9C3" iconColor="#D97706"
              icon={<svg width="20" height="20" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>}
            />
            <StatCard
              loading={statsLoading}
              num={stats?.in_progress} label="In Progress" sub="Workflow active"
              iconBg="#DBEAFE" iconColor="#2563EB"
              icon={<svg width="20" height="20" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2"><path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/></svg>}
            />
            <StatCard
              loading={statsLoading}
              num={stats?.completed} label="Completed" sub="Fully signed"
              iconBg="#DCFCE7" iconColor="#16A34A"
              icon={<svg width="20" height="20" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2"><path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>}
            />
            <StatCard
              loading={statsLoading}
              num={stats?.declined} label="Declined" sub="Signer refused"
              iconBg="#FFF7ED" iconColor="#B45309"
              icon={<svg width="20" height="20" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><path strokeLinecap="round" strokeLinejoin="round" d="M15 9l-6 6m0-6l6 6"/></svg>}
            />
            <StatCard
              loading={statsLoading}
              num={stats?.total} label="Total" sub="All documents"
              iconBg="#F3E8FF" iconColor="#9333EA"
              icon={<svg width="20" height="20" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2"><path strokeLinecap="round" strokeLinejoin="round" d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z"/></svg>}
            />
          </div>

          {/* ── Document List ────────────────────────────────────────────────── */}
          <div style={{ background: 'white', borderRadius: 16, border: '1px solid #E2E8F0', overflow: 'hidden', boxShadow: '0 1px 4px rgba(0,0,0,0.04)' }}>

            {/* Header row: title + search + upload */}
            <div style={{
              display: 'flex', alignItems: 'center', gap: '0.75rem',
              padding: '1rem 1.25rem', borderBottom: '1px solid #F1F5F9',
              flexWrap: 'wrap',
            }}>
              <div style={{ flex: 1, minWidth: 120 }}>
                <h2 style={{ fontSize: '0.95rem', fontWeight: 700, color: '#0F172A', margin: 0 }}>
                  Documents
                </h2>
                {/* "Showing X of Y" — only shows when we have data */}
                {!loading && total > 0 && (
                  <p style={{ fontSize: '0.72rem', color: '#94A3B8', margin: '2px 0 0', fontWeight: 400 }}>
                    Showing <strong style={{ color: '#64748B' }}>{loadedCount.toLocaleString()}</strong> of{' '}
                    <strong style={{ color: '#64748B' }}>{total.toLocaleString()}</strong> documents
                  </p>
                )}
              </div>

              {/* Search */}
              <div style={{
                display: 'flex', alignItems: 'center', gap: '0.5rem',
                background: '#F8FAFC', border: '1px solid #E2E8F0', borderRadius: 9,
                padding: '0.4rem 0.85rem',
              }}>
                <svg width="13" height="13" fill="none" viewBox="0 0 24 24" stroke="#94A3B8" strokeWidth="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35" strokeLinecap="round"/></svg>
                <input
                  value={searchRaw}
                  onChange={e => setSearchRaw(e.target.value)}
                  placeholder="Search documents..."
                  aria-label="Search documents"
                  style={{ background: 'transparent', border: 'none', outline: 'none', fontSize: '0.83rem', color: '#0F172A', width: 140 }}
                />
                {searchRaw && (
                  <button
                    onClick={() => setSearchRaw('')}
                    style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#94A3B8', padding: 0, lineHeight: 1, fontSize: '0.9rem' }}
                    aria-label="Clear search"
                  >
                    ×
                  </button>
                )}
              </div>

              <button onClick={() => navigate('/upload')}
                style={{
                  display: 'flex', alignItems: 'center', gap: '0.4rem',
                  padding: '0.4rem 0.9rem', background: '#2563EB', color: 'white',
                  border: 'none', borderRadius: 9, fontWeight: 600, fontSize: '0.82rem', cursor: 'pointer',
                  boxShadow: '0 2px 8px rgba(37,99,235,0.25)',
                }}
                onMouseEnter={e => e.currentTarget.style.background = '#1D4ED8'}
                onMouseLeave={e => e.currentTarget.style.background = '#2563EB'}
              >
                <svg width="13" height="13" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2.5"><path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4"/></svg>
                Upload
              </button>
            </div>

            {/* Filter pills */}
            <div style={{ display: 'flex', gap: '0.3rem', padding: '0.75rem 1.25rem', borderBottom: '1px solid #F1F5F9', overflowX: 'auto', flexWrap: 'wrap' }}>
              {FILTERS.map(f => (
                <button key={f.key} onClick={() => setFilter(f.key)}
                  style={{
                    padding: '0.3rem 0.85rem', borderRadius: 20, border: '1px solid',
                    borderColor: filter === f.key ? '#BFDBFE' : '#E2E8F0',
                    background:  filter === f.key ? '#EFF6FF' : 'transparent',
                    color:       filter === f.key ? '#2563EB' : '#64748B',
                    fontSize: '0.78rem', fontWeight: filter === f.key ? 700 : 500, cursor: 'pointer',
                    whiteSpace: 'nowrap', transition: 'all 0.15s ease',
                  }}>
                  {f.label}
                </button>
              ))}
            </div>

            {/* Table */}
            <div>
              {/* Desktop column headers (sortable) */}
              <div className="dt-head" style={{ fontSize: '0.7rem', fontWeight: 700, color: '#94A3B8', letterSpacing: '0.06em', textTransform: 'uppercase' }}>
                <span style={{ flex: 3 }}>Document</span>
                <span style={{ flex: 1.8, textAlign: 'center' }}>Status</span>
                <button
                  onClick={() => toggleSort('created_at')}
                  style={{ flex: 1.8, textAlign: 'center', background: 'none', border: 'none', cursor: 'pointer', fontSize: '0.7rem', fontWeight: 700, color: '#94A3B8', letterSpacing: '0.06em', textTransform: 'uppercase', padding: 0 }}
                >
                  Date <SortArrow field="created_at" />
                </button>
                <span style={{ flex: 1 }} />
              </div>

              {/* Loading state: skeleton rows */}
              {loading && (
                <div>
                  {[1, 2, 3, 4, 5].map(i => <SkeletonRow key={i} />)}
                </div>
              )}

              {/* Error state */}
              {!loading && error && (
                <ErrorState error={error} onRetry={retry} />
              )}

              {/* Empty state */}
              {!loading && !error && documents.length === 0 && (
                <EmptyState search={searchRaw} statusFilter={filter} navigate={navigate} />
              )}

              {/* Document rows */}
              {!loading && !error && documents.map((doc, i) => (
                <DocRow key={doc.id} doc={doc} index={i} navigate={navigate} />
              ))}

              {/* Load-more section */}
              {!loading && !error && documents.length > 0 && (
                <div style={{
                  padding: '1rem 1.25rem',
                  borderTop: '1px solid #F1F5F9',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  flexWrap: 'wrap',
                  gap: '0.5rem',
                }}>
                  {/* Progress indicator */}
                  <span style={{ fontSize: '0.78rem', color: '#94A3B8' }}>
                    {loadedCount < total
                      ? `${loadedCount.toLocaleString()} of ${total.toLocaleString()} loaded`
                      : `All ${total.toLocaleString()} document${total !== 1 ? 's' : ''} loaded`}
                  </span>

                  {/* Progress bar */}
                  {total > 0 && (
                    <div style={{
                      flex: 1, minWidth: 80, maxWidth: 200,
                      height: 4, background: '#E2E8F0', borderRadius: 4, overflow: 'hidden',
                    }}>
                      <div style={{
                        height: '100%', background: '#2563EB', borderRadius: 4,
                        width: `${Math.min((loadedCount / total) * 100, 100)}%`,
                        transition: 'width 0.3s ease',
                      }} />
                    </div>
                  )}

                  {/* Load More button */}
                  {hasMore && (
                    <button
                      onClick={loadMore}
                      disabled={loadingMore}
                      style={{
                        padding: '0.45rem 1.1rem',
                        background: loadingMore ? '#F1F5F9' : 'white',
                        border: '1px solid #E2E8F0',
                        borderRadius: 9,
                        fontWeight: 600,
                        fontSize: '0.82rem',
                        color: loadingMore ? '#94A3B8' : '#2563EB',
                        cursor: loadingMore ? 'not-allowed' : 'pointer',
                        display: 'flex',
                        alignItems: 'center',
                        gap: '0.4rem',
                        transition: 'all 0.15s',
                      }}
                      onMouseEnter={e => { if (!loadingMore) e.currentTarget.style.background = '#EFF6FF'; }}
                      onMouseLeave={e => { e.currentTarget.style.background = loadingMore ? '#F1F5F9' : 'white'; }}
                    >
                      {loadingMore ? (
                        <>
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" style={{ animation: 'spin 0.8s linear infinite' }}>
                            <path strokeLinecap="round" d="M12 2a10 10 0 1 0 10 10"/>
                          </svg>
                          <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
                          Loading…
                        </>
                      ) : (
                        <>
                          Load more
                          <svg width="12" height="12" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2.5"><path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7"/></svg>
                        </>
                      )}
                    </button>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* View all link (preserved for users who want the full Manage page) */}
          {!loading && total > 0 && (
            <div style={{ textAlign: 'center', marginTop: '1.25rem' }}>
              <button onClick={() => navigate('/manage')}
                style={{ background: 'none', border: 'none', color: '#2563EB', fontSize: '0.85rem', fontWeight: 600, cursor: 'pointer', textDecoration: 'underline' }}>
                Open full document manager →
              </button>
            </div>
          )}
        </main>
      </div>
    </AppShell>
  );
}
