// /frontend/src/hooks/useDocumentPagination.js
//
// ENTERPRISE CURSOR-PAGINATION HOOK
//
// Manages the full lifecycle of paginated document fetching:
//   ✔ Cursor-based pagination (stable across mutations)
//   ✔ Race-condition prevention via AbortController + requestId
//   ✔ Request deduplication (in-flight guard)
//   ✔ Automatic retry with exponential back-off on transient failures
//   ✔ Filter + sort + search state, persisted across filter changes
//   ✔ Accumulated documents list (load-more pattern)
//   ✔ "Showing X of Y" data for UX
//   ✔ Auth expiry handled (403/401 propagated up)
//   ✔ Deleted-document deduplication (documents that disappeared between pages)
//
// ARCHITECTURE NOTE — why load-more vs infinite scroll:
//   Load-more is chosen over intersection-observer infinite scroll because:
//   1. Documents are a task-management surface, not a feed. Users intentionally
//      seek specific documents — auto-loading creates disorientation.
//   2. Mobile: auto-scroll fights with pull-to-refresh and content below the list.
//   3. Enterprise users on slow networks prefer explicit control over data usage.
//   Load-more can be converted to infinite scroll later by wiring the
//   `loadMore` function to an IntersectionObserver without any state changes.

import { useState, useEffect, useCallback, useRef } from 'react';
import api from '../services/api';

// ── Constants ──────────────────────────────────────────────────────────────────
const DEFAULT_LIMIT   = 25;
const MAX_RETRIES     = 3;
const RETRY_BASE_MS   = 800;  // Exponential base: 800ms, 1.6s, 3.2s

// ── Helpers ────────────────────────────────────────────────────────────────────
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * useDocumentPagination
 *
 * @param {object} options
 * @param {string}  options.status  - status filter key
 * @param {string}  options.search  - search string
 * @param {string}  options.sort    - sort column
 * @param {string}  options.dir     - sort direction
 * @param {number}  options.limit   - page size (default 25)
 */
export function useDocumentPagination({
  status = 'all',
  search = '',
  sort   = 'created_at',
  dir    = 'desc',
  limit  = DEFAULT_LIMIT,
} = {}) {
  // ── State ──────────────────────────────────────────────────────────────────
  const [documents,    setDocuments]    = useState([]);
  const [total,        setTotal]        = useState(0);
  const [nextCursor,   setNextCursor]   = useState(null);
  const [hasMore,      setHasMore]      = useState(false);
  const [loading,      setLoading]      = useState(true);  // true on initial load
  const [loadingMore,  setLoadingMore]  = useState(false); // true on load-more
  const [error,        setError]        = useState(null);
  const [loadedCount,  setLoadedCount]  = useState(0);     // cumulative items shown

  // ── Refs (do not trigger re-renders) ──────────────────────────────────────
  // Tracks whether a fetch is in-flight to prevent duplicate requests.
  const fetchingRef    = useRef(false);
  // AbortController for the current in-flight request.
  const abortCtrlRef   = useRef(null);
  // Monotonic counter — each new fetch gets a higher ID.
  // When a response arrives, we check if its ID matches the latest.
  // Stale responses (from cancelled or superseded fetches) are discarded.
  const requestIdRef   = useRef(0);

  // ── Core fetch function ────────────────────────────────────────────────────
  /**
   * fetchPage — internal fetch with retry, race-condition guard, deduplication.
   *
   * @param {string|null} cursor   - null for first page
   * @param {boolean}     append   - true for load-more, false to reset list
   * @param {number}      myId     - request ID for staleness check
   */
  const fetchPage = useCallback(async (cursor, append, myId) => {
    // ── Build query params ───────────────────────────────────────────────────
    const params = { limit, sort, dir };
    if (status && status !== 'all') params.status = status;
    if (search.trim()) params.search = search.trim();
    if (cursor) params.cursor = cursor;

    // ── Retry loop ───────────────────────────────────────────────────────────
    let attempt = 0;
    while (attempt <= MAX_RETRIES) {
      // Abort previous request if still alive
      if (abortCtrlRef.current) {
        abortCtrlRef.current.abort();
      }
      const ctrl = new AbortController();
      abortCtrlRef.current = ctrl;

      try {
        const response = await api.get('/documents', {
          params,
          signal: ctrl.signal,
        });

        // ── Staleness check ────────────────────────────────────────────────
        // If a newer fetch was started after this one, discard this result.
        if (myId !== requestIdRef.current) return;

        const data = response.data;

        setTotal(data.total ?? 0);
        setNextCursor(data.nextCursor ?? null);
        setHasMore(data.hasMore ?? false);

        if (append) {
          // Load-more: append to existing list, deduplicate by id
          // Deduplication handles the edge case where a document was inserted
          // at the boundary between two pages (cursor-safe but id-checked).
          setDocuments(prev => {
            const existingIds = new Set(prev.map(d => d.id));
            const newDocs = (data.documents || []).filter(d => !existingIds.has(d.id));
            return [...prev, ...newDocs];
          });
          setLoadedCount(prev => prev + (data.documents?.length ?? 0));
        } else {
          // Initial / filter-change: replace list entirely
          setDocuments(data.documents || []);
          setLoadedCount(data.documents?.length ?? 0);
        }

        setError(null);
        return; // Success — exit retry loop

      } catch (err) {
        // ── Staleness check on error ───────────────────────────────────────
        if (myId !== requestIdRef.current) return;

        // Abort = intentional cancel, not an error
        if (err.name === 'CanceledError' || err.name === 'AbortError') return;

        // Auth errors should not be retried
        if (err.response?.status === 401 || err.response?.status === 403) {
          setError({ type: 'auth', message: 'Session expired. Please log in again.' });
          return;
        }

        // On the last attempt, set the error state
        if (attempt === MAX_RETRIES) {
          const status5xx = err.response?.status >= 500;
          setError({
            type: 'network',
            message: status5xx
              ? 'Server error. Please try again in a moment.'
              : 'Could not load documents. Check your connection.',
            retryable: true,
          });
          return;
        }

        // Wait with exponential back-off before retrying
        await sleep(RETRY_BASE_MS * Math.pow(2, attempt));
        attempt++;
      }
    }
  }, [status, search, sort, dir, limit]);

  // ── Reset + initial load on filter/sort/search change ─────────────────────
  // Every time a filter-level param changes, we reset the list and fetch from
  // page 1. We do NOT reset if only `loadMore` is called.
  useEffect(() => {
    // Cancel any in-flight request from a previous filter state
    if (abortCtrlRef.current) {
      abortCtrlRef.current.abort();
    }
    fetchingRef.current = false;

    // Assign a new request ID — any in-flight response from the previous
    // filter will be discarded when it checks myId !== requestIdRef.current
    const myId = ++requestIdRef.current;

    // Reset pagination state
    setDocuments([]);
    setTotal(0);
    setNextCursor(null);
    setHasMore(false);
    setLoadedCount(0);
    setError(null);
    setLoading(true);
    setLoadingMore(false);

    (async () => {
      fetchingRef.current = true;
      await fetchPage(null, false, myId);
      if (myId === requestIdRef.current) {
        setLoading(false);
        fetchingRef.current = false;
      }
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, search, sort, dir, limit]);

  // ── Load more (called from "Load More" button or IntersectionObserver) ────
  const loadMore = useCallback(async () => {
    // Guard: don't fire if already fetching, no more pages, or errored
    if (fetchingRef.current || !hasMore || !nextCursor || error) return;

    const myId = ++requestIdRef.current;
    fetchingRef.current = true;
    setLoadingMore(true);

    await fetchPage(nextCursor, true, myId);

    if (myId === requestIdRef.current) {
      setLoadingMore(false);
      fetchingRef.current = false;
    }
  }, [fetchPage, hasMore, nextCursor, error]);

  // ── Manual retry after error ───────────────────────────────────────────────
  const retry = useCallback(() => {
    const myId = ++requestIdRef.current;
    setError(null);
    setLoading(true);
    setDocuments([]);
    setLoadedCount(0);
    fetchingRef.current = true;

    (async () => {
      await fetchPage(null, false, myId);
      if (myId === requestIdRef.current) {
        setLoading(false);
        fetchingRef.current = false;
      }
    })();
  }, [fetchPage]);

  // ── Cleanup on unmount ─────────────────────────────────────────────────────
  useEffect(() => {
    return () => {
      if (abortCtrlRef.current) abortCtrlRef.current.abort();
      // Invalidate any pending async operations
      requestIdRef.current++;
    };
  }, []);

  return {
    documents,
    total,
    hasMore,
    loadedCount,
    loading,
    loadingMore,
    error,
    loadMore,
    retry,
  };
}
