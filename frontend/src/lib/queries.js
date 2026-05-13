/**
 * queries.js — HakikiSign Centralized Query & Mutation Hooks
 *
 * ALL server-state lives here. Pages import these hooks instead of calling
 * api.js directly. This eliminates:
 *   - Duplicated API call logic across Dashboard/Manage/ViewDocument
 *   - Inconsistent loading/error states
 *   - Race conditions from competing useEffect fetches
 *   - Duplicate requests (TanStack deduplicates concurrent queries)
 *
 * ARCHITECTURE:
 *   useQuery  → reads (cached, deduplicated, background-refreshed)
 *   useMutation → writes (optimistic updates, cache invalidation, retries)
 *
 * OPTIMISTIC UPDATES:
 *   Document status mutations (void, send, remind) update cache immediately
 *   and roll back on error, so the UI never shows stale state after action.
 */

import { useQuery, useMutation, useQueryClient, useInfiniteQuery } from '@tanstack/react-query';
import api from '../services/api';
import { QUERY_KEYS, broadcastInvalidation } from './queryClient';

// ═══════════════════════════════════════════════════════════════════════════════
// DOCUMENT QUERIES
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * useDocumentStats — fetches aggregated document counts.
 * Stale after 60s, but shown immediately from cache on revisit.
 * Used by Dashboard stat cards.
 */
export function useDocumentStats() {
  return useQuery({
    queryKey: QUERY_KEYS.documentStats(),
    queryFn: () => api.get('/documents/stats').then(r => r.data.stats),
    staleTime: 60_000,
  });
}

/**
 * useDocumentList — paginated document list with filters.
 * Separate query per filter combination → instant switching between tabs.
 * @param {object} params - { status, search, sort, dir, limit }
 */
export function useDocumentList(params) {
  const { status = 'all', search = '', sort = 'created_at', dir = 'desc', limit = 25 } = params || {};

  return useQuery({
    queryKey: QUERY_KEYS.documents({ status, search, sort, dir, limit }),
    queryFn: ({ signal }) => {
      const p = { limit, sort, dir };
      if (status && status !== 'all') p.status = status;
      if (search?.trim()) p.search = search.trim();
      return api.get('/documents', { params: p, signal }).then(r => r.data);
    },
    // Keep previous data during filter transitions → no flash of empty state
    placeholderData: (prev) => prev,
    staleTime: 30_000,
  });
}

/**
 * useInfiniteDocuments — infinite cursor-pagination for Dashboard load-more.
 * Replaces useDocumentPagination hook with TanStack's built-in infinite query.
 * Deduplicates requests, caches pages, supports background revalidation.
 */
export function useInfiniteDocuments(params) {
  const { status = 'all', search = '', sort = 'created_at', dir = 'desc', limit = 25 } = params || {};

  return useInfiniteQuery({
    queryKey: [...QUERY_KEYS.documents({ status, search, sort, dir, limit }), 'infinite'],
    queryFn: ({ pageParam = null, signal }) => {
      const p = { limit, sort, dir };
      if (status && status !== 'all') p.status = status;
      if (search?.trim()) p.search = search.trim();
      if (pageParam) p.cursor = pageParam;
      return api.get('/documents', { params: p, signal }).then(r => r.data);
    },
    initialPageParam: null,
    getNextPageParam: (lastPage) => lastPage.hasMore ? lastPage.nextCursor : undefined,
    staleTime: 30_000,
    // Keep all pages in cache — don't discard prior pages on refetch
    maxPages: 0,
  });
}

/**
 * useDocument — single document detail.
 * Pre-populated from list cache if available (no flash on navigation).
 */
export function useDocument(id) {
  const queryClient = useQueryClient();
  return useQuery({
    queryKey: QUERY_KEYS.document(id),
    queryFn: ({ signal }) => api.get(`/documents/${id}`, { signal }).then(r => r.data),
    enabled: !!id,
    staleTime: 30_000,
    // Seed from list cache if available — instant initial render
    initialData: () => {
      const allCaches = queryClient.getQueriesData({ queryKey: ['documents', 'list'] });
      for (const [, data] of allCaches) {
        if (!data) continue;
        // Handle both paginated (pages array) and flat (documents array) shapes
        const docs = data.documents || data.pages?.flatMap(p => p.documents) || [];
        const found = docs.find(d => String(d.id) === String(id));
        if (found) return found;
      }
      return undefined;
    },
    initialDataUpdatedAt: () => {
      // Mark seed data as stale so a fresh fetch happens immediately
      return 0;
    },
  });
}

/**
 * useSigners — signer list for a document.
 */
export function useSigners(docId) {
  return useQuery({
    queryKey: QUERY_KEYS.signers(docId),
    queryFn: ({ signal }) => api.get(`/signers/${docId}`, { signal }).then(r => r.data),
    enabled: !!docId,
    staleTime: 30_000,
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// AUDIT QUERIES
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * useAuditLog — audit log for a specific document or all documents.
 */
export function useAuditLog(docId) {
  return useQuery({
    queryKey: docId ? QUERY_KEYS.audit(docId) : QUERY_KEYS.auditAll(),
    queryFn: ({ signal }) => {
      const url = docId ? `/audit/document/${docId}` : '/audit?limit=100';
      return api.get(url, { signal }).then(r => r.data);
    },
    staleTime: 60_000,
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// USER QUERIES
// ═══════════════════════════════════════════════════════════════════════════════

export function useUserProfile() {
  return useQuery({
    queryKey: QUERY_KEYS.user(),
    queryFn: ({ signal }) => api.get('/auth/me', { signal }).then(r => r.data),
    staleTime: 5 * 60_000,
    // Don't refetch on window focus — profile rarely changes
    refetchOnWindowFocus: false,
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// DOCUMENT MUTATIONS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * useSendDocument — send document to signers.
 * Optimistic update: mark as "in_progress" immediately.
 */
export function useSendDocument() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id) => api.post(`/documents/${id}/send`).then(r => r.data),

    onMutate: async (id) => {
      // Cancel any outgoing refetches to avoid overwriting optimistic update
      await queryClient.cancelQueries({ queryKey: QUERY_KEYS.document(id) });
      const previous = queryClient.getQueryData(QUERY_KEYS.document(id));

      // Optimistic update
      queryClient.setQueryData(QUERY_KEYS.document(id), old =>
        old ? { ...old, status: 'in_progress' } : old
      );
      return { previous, id };
    },

    onError: (err, id, context) => {
      // Roll back on failure
      if (context?.previous) {
        queryClient.setQueryData(QUERY_KEYS.document(context.id), context.previous);
      }
    },

    onSuccess: (data, id) => {
      // Invalidate document + lists + stats so all views reflect new status
      broadcastInvalidation([
        QUERY_KEYS.document(id),
        QUERY_KEYS.documents(),
        QUERY_KEYS.documentStats(),
      ]);
    },
  });
}

/**
 * useVoidDocument — void a document.
 * Optimistic update: mark as "voided" immediately.
 */
export function useVoidDocument() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ id, reason }) => api.post(`/documents/${id}/void`, { reason }).then(r => r.data),

    onMutate: async ({ id }) => {
      await queryClient.cancelQueries({ queryKey: QUERY_KEYS.document(id) });
      const previous = queryClient.getQueryData(QUERY_KEYS.document(id));
      queryClient.setQueryData(QUERY_KEYS.document(id), old =>
        old ? { ...old, status: 'voided' } : old
      );
      return { previous, id };
    },

    onError: (err, { id }, context) => {
      if (context?.previous) {
        queryClient.setQueryData(QUERY_KEYS.document(id), context.previous);
      }
    },

    onSuccess: (data, { id }) => {
      broadcastInvalidation([
        QUERY_KEYS.document(id),
        QUERY_KEYS.documents(),
        QUERY_KEYS.documentStats(),
      ]);
    },
  });
}

/**
 * useRemindDocument — send reminder to pending signers.
 */
export function useRemindDocument() {
  return useMutation({
    mutationFn: (id) => api.post(`/documents/${id}/remind`).then(r => r.data),
    // No cache change needed — reminder doesn't alter document state
  });
}

/**
 * useUploadDocument — upload a new document.
 * Invalidates document list and stats on success.
 */
export function useUploadDocument() {
  return useMutation({
    mutationFn: ({ formData, onUploadProgress }) =>
      api.post('/documents/upload', formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
        onUploadProgress,
      }).then(r => r.data),

    onSuccess: () => {
      broadcastInvalidation([
        QUERY_KEYS.documents(),
        QUERY_KEYS.documentStats(),
      ]);
    },
  });
}

/**
 * useAddSigner — add a signer to a document.
 */
export function useAddSigner() {
  return useMutation({
    mutationFn: ({ docId, signerData }) =>
      api.post(`/signers/${docId}/add`, signerData).then(r => r.data),

    onSuccess: (data, { docId }) => {
      broadcastInvalidation([QUERY_KEYS.signers(docId)]);
    },
  });
}

/**
 * useRegenerateSignerLink — regenerate signing link for a signer.
 */
export function useRegenerateSignerLink() {
  return useMutation({
    mutationFn: ({ docId, email }) =>
      api.post(`/signers/${docId}/regenerate-link`, { email }).then(r => r.data),
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// SETTINGS MUTATIONS
// ═══════════════════════════════════════════════════════════════════════════════

export function useUpdateProfile() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data) => api.post('/auth/update-profile', data).then(r => r.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.user() });
    },
  });
}

export function useChangePassword() {
  return useMutation({
    mutationFn: (data) => api.post('/auth/change-password', data).then(r => r.data),
  });
}

export function useToggleMfa() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data) => api.post('/auth/toggle-mfa', data).then(r => r.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.user() });
    },
  });
}
