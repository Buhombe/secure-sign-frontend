-- ============================================================================
-- Migration 006: Pagination Performance Indexes
-- Purpose: Harden query performance for cursor-based pagination on the
--          documents table. Without these indexes, PostgreSQL performs full
--          table scans on every paginated request — unacceptable at scale.
--
-- Strategy: Composite indexes covering the exact column combinations used
-- in WHERE + ORDER BY clauses of the paginated list endpoint. PostgreSQL can
-- satisfy both the filter and the sort from a single index scan (Index Only
-- Scan in many cases), avoiding a separate sort step entirely.
--
-- Cursor pagination uses: WHERE user_id = $1 AND created_at < $cursor
--   ORDER BY created_at DESC
-- Filtered:              WHERE user_id = $1 AND status = $2 AND created_at < $cursor
--   ORDER BY created_at DESC
-- Search:                WHERE user_id = $1 AND original_name ILIKE $search
--   (falls back to partial index scan — GIN trigram index added below)
--
-- Run: psql $DATABASE_URL -f migrations/006_pagination_indexes.sql
-- Safe to run on a live database — CREATE INDEX CONCURRENTLY does not lock.
-- ============================================================================



-- ── Primary pagination index ─────────────────────────────────────────────────
-- Covers: WHERE user_id = $1 AND is_deleted = FALSE ORDER BY created_at DESC
-- This is the hot path for every dashboard load.
-- The partial index (WHERE is_deleted = FALSE) makes it smaller and faster
-- than a full index — deleted rows are excluded from the B-tree entirely.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_documents_paginate_primary
  ON documents (user_id, created_at DESC)
  WHERE is_deleted = FALSE;

-- ── Status-filtered pagination index ────────────────────────────────────────
-- Covers: WHERE user_id = $1 AND status = $2 AND is_deleted = FALSE
--          ORDER BY created_at DESC
-- Required for status filter pills (Pending / In Progress / Completed / etc.)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_documents_paginate_status
  ON documents (user_id, status, created_at DESC)
  WHERE is_deleted = FALSE;

-- ── Org-scoped pagination index ─────────────────────────────────────────────
-- Covers enterprise admin views scoped to org_id.
-- Future-proof: org_id column already exists from migration 001.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_documents_paginate_org
  ON documents (org_id, created_at DESC)
  WHERE is_deleted = FALSE;

-- ── Trigram index for search ─────────────────────────────────────────────────
-- Enables ILIKE '%query%' to use an index scan instead of a full table scan.
-- pg_trgm extension is available on all major managed Postgres providers
-- (RDS, Supabase, Neon, Railway). If unavailable, the search query falls back
-- gracefully to a seq scan — just slower on very large datasets.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_documents_name_trgm
  ON documents USING GIN (original_name gin_trgm_ops)
  WHERE is_deleted = FALSE;

-- ── Covering index for list projection ──────────────────────────────────────
-- Includes the columns we SELECT in the list endpoint so PostgreSQL can
-- satisfy the query from the index alone (Index Only Scan), avoiding heap
-- fetches entirely for the common case.
-- Columns: id, original_name, status, created_at, recipient_email, signed_at, signed_by
-- Note: INCLUDE is available in PostgreSQL 11+.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_documents_list_covering
  ON documents (user_id, created_at DESC)
  INCLUDE (id, original_name, status, recipient_email, signed_at, signed_by)
  WHERE is_deleted = FALSE;

-- ── Audit log pagination ─────────────────────────────────────────────────────
-- The AuditLog page also lists by user/document — index it too.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_audit_logs_paginate
  ON audit_logs (user_id, timestamp DESC);



-- ── EXPLAIN ANALYZE verification queries ────────────────────────────────────
-- After running this migration on staging, verify with:
--
-- EXPLAIN (ANALYZE, BUFFERS)
--   SELECT id, original_name, status, created_at, recipient_email, signed_at, signed_by
--   FROM documents
--   WHERE user_id = '<test_uuid>'
--     AND is_deleted = FALSE
--     AND created_at < NOW()
--   ORDER BY created_at DESC
--   LIMIT 25;
--
-- Expected: "Index Only Scan using idx_documents_list_covering"
-- NOT:      "Seq Scan" or "Bitmap Heap Scan"
-- ── Estimated impact ─────────────────────────────────────────────────────────
-- Small accounts  (< 100 docs):  sub-1ms query time (unchanged from before)
-- Medium accounts (1k docs):     ~0.5ms vs ~20ms without index (40× faster)
-- Large accounts  (10k+ docs):   ~1ms vs ~200ms+ without index (200× faster)
