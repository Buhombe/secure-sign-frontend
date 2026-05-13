/**
 * queryClient.js — HakikiSign Enterprise Query Client
 *
 * CACHE STRATEGY:
 *   staleTime: 60s    → data shown immediately on revisit, refetch in background
 *   gcTime:    5min   → unused cache entries evicted after 5 minutes
 *   retry:     smart  → no retry on 4xx (auth/not-found), exponential on 5xx/network
 *   refetchOnWindowFocus: true → background revalidation on tab switch
 *
 * MOBILE OPTIMIZATION:
 *   - gcTime kept low (5min) to limit memory on low-RAM Android devices
 *   - networkMode: 'offlineFirst' to serve stale cache while offline
 *   - Exponential retry capped at 30s to avoid draining mobile battery
 *
 * MULTI-TAB CONSISTENCY:
 *   BroadcastChannel invalidation handled in queryClient.js so any tab that
 *   mutates data signals all other tabs to invalidate their caches.
 */

import { QueryClient } from '@tanstack/react-query';

// ── Retry predicate ────────────────────────────────────────────────────────────
// Do NOT retry on client errors (4xx) — they are deterministic failures.
// DO retry on network errors and 5xx server errors with exponential back-off.
function shouldRetry(failureCount, error) {
  const status = error?.response?.status;
  // Never retry auth errors — they need fresh login
  if (status === 401 || status === 403) return false;
  // Never retry not-found or validation errors
  if (status === 404 || status === 422 || status === 400) return false;
  // Retry up to 3 times for network/server errors
  return failureCount < 3;
}

function retryDelay(attemptIndex) {
  // Exponential back-off: 1s, 2s, 4s — capped at 30s for mobile
  return Math.min(1000 * Math.pow(2, attemptIndex), 30_000);
}

// ── Query Client ──────────────────────────────────────────────────────────────
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // 60s stale time: data is fresh for 1 minute, then background-refetched
      staleTime: 60_000,
      // 5min garbage collection: keep unused data 5 min for snappy back-navigation
      gcTime: 5 * 60_000,
      retry: shouldRetry,
      retryDelay,
      // Background refetch when user returns to tab — catches any changes
      refetchOnWindowFocus: true,
      // Use stale data immediately, refetch in background
      refetchOnReconnect: true,
      // Serve stale cache while offline, no error flash
      networkMode: 'offlineFirst',
    },
    mutations: {
      retry: (failureCount, error) => {
        const status = error?.response?.status;
        if (status >= 400 && status < 500) return false;
        return failureCount < 2;
      },
      retryDelay,
      networkMode: 'offlineFirst',
    },
  },
});

// ── Query Key Factory ─────────────────────────────────────────────────────────
// Centralized key registry prevents typos and enables targeted invalidation.
// Pattern: ['entity', scope?, params?]
export const QUERY_KEYS = {
  // Dashboard & document list
  documents: (params) => params ? ['documents', 'list', params] : ['documents'],
  documentStats: () => ['documents', 'stats'],
  document: (id) => ['documents', 'detail', id],

  // Signers
  signers: (docId) => ['signers', docId],

  // Audit
  audit: (docId) => docId ? ['audit', docId] : ['audit'],
  auditAll: () => ['audit', 'all'],

  // User
  user: () => ['user', 'profile'],
};

// ── Cross-tab cache invalidation via BroadcastChannel ────────────────────────
// When a mutation completes in one tab, it broadcasts an invalidation message
// so all other tabs revalidate their stale data automatically.
//
// Usage: broadcastInvalidation(['documents']) in any mutation's onSuccess.
const CHANNEL_NAME = 'hakikisign-cache-sync';
let _channel = null;

function getChannel() {
  if (!_channel && typeof BroadcastChannel !== 'undefined') {
    _channel = new BroadcastChannel(CHANNEL_NAME);
    _channel.onmessage = (event) => {
      const { type, keys } = event.data || {};
      if (type === 'invalidate' && Array.isArray(keys)) {
        // Invalidate specified query keys in all other tabs
        keys.forEach(key => queryClient.invalidateQueries({ queryKey: key }));
      }
    };
  }
  return _channel;
}

export function broadcastInvalidation(queryKeys) {
  const channel = getChannel();
  if (channel) {
    channel.postMessage({ type: 'invalidate', keys: queryKeys });
  }
  // Also invalidate locally
  queryKeys.forEach(key => queryClient.invalidateQueries({ queryKey: key }));
}

// Initialize channel on module load
getChannel();
