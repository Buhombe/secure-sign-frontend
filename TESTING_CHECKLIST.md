# HakikiSign — Enterprise Pagination: Testing & Verification Checklist

## A. SMALL DATASET TESTS (5–20 documents)

### A1. First-page load
- [ ] Dashboard loads without `.slice(0,20)` cap — all documents visible
- [ ] Stats cards show accurate counts (no longer computed from truncated array)
- [ ] "Showing X of Y" displays correct numbers (e.g. "Showing 12 of 12 documents")
- [ ] "All 12 documents loaded" label appears in footer (no Load More button)
- [ ] Progress bar shows 100% filled

### A2. Empty state
- [ ] New account with 0 docs shows empty state with Upload CTA
- [ ] Applying a filter on an account with docs but no matches for that filter shows "No results found"
- [ ] Clearing filters restores the document list without a page reload

### A3. API verification
```bash
# Verify response shape
curl -H "Authorization: Bearer $TOKEN" \
  "$API_BASE/documents?limit=25" | jq '{total, hasMore, nextCursor, docCount: (.documents|length)}'

# Expected for 12 docs:
# { "total": 12, "hasMore": false, "nextCursor": null, "docCount": 12 }
```

---

## B. LARGE DATASET TESTS (1,000+ documents)

### B1. Pagination mechanics
- [ ] First page loads 25 docs (default limit)
- [ ] `nextCursor` is present in response, `hasMore: true`
- [ ] Clicking "Load more" appends 25 more docs
- [ ] `loadedCount` increments correctly after each load-more
- [ ] "Showing 50 of 1247 loaded" displays correctly
- [ ] Progress bar advances proportionally

### B2. No duplicate documents
- [ ] Load page 1 (docs 1–25), then page 2 (docs 26–50)
- [ ] Inspect rendered list — no document ID appears twice
- [ ] This tests the `existingIds` deduplication in the hook

### B3. Filter state persistence
- [ ] Set filter to "Pending", load 3 pages
- [ ] Switch to "Completed" — list resets to page 1 of completed docs
- [ ] Switch back to "Pending" — list resets (not retained — by design, avoids stale state)
- [ ] Correct: filter changes always restart from page 1

### B4. Search + pagination
- [ ] Enter "Contract" in search — list resets and shows only matching docs
- [ ] "Load more" continues with the same search filter applied
- [ ] Clear search — list resets to unfiltered first page

### B5. Database query verification
```sql
-- Run EXPLAIN ANALYZE on staging to confirm index usage:
EXPLAIN (ANALYZE, BUFFERS)
SELECT id, original_name, status, created_at, recipient_email, signed_at, signed_by
FROM documents d
WHERE d.user_id = '<uuid>'
  AND d.is_deleted = FALSE
  AND d.created_at < '2026-01-01T00:00:00Z'
ORDER BY d.created_at DESC, d.id DESC
LIMIT 26;

-- MUST show: "Index Only Scan using idx_documents_list_covering"
-- NOT:       "Seq Scan" or "Bitmap Heap Scan"

-- Verify count query uses index:
EXPLAIN (ANALYZE, BUFFERS)
SELECT COUNT(*) FROM documents d
WHERE d.user_id = '<uuid>' AND d.is_deleted = FALSE;
-- Should use: idx_documents_paginate_primary
```

### B6. Timing assertions
| Dataset size | Expected GET /documents p95 |
|---|---|
| 100 docs     | < 10ms                       |
| 1,000 docs   | < 20ms                       |
| 10,000 docs  | < 50ms                       |
| 100,000 docs | < 100ms                      |

---

## C. MOBILE TESTS

### C1. Slow network simulation (Chrome DevTools → Slow 3G)
- [ ] Skeleton rows appear immediately on page load (not blank white)
- [ ] Stats cards show pulse animation while loading
- [ ] "Load more" button shows spinner while fetching
- [ ] Search box is usable without triggering a request on every keystroke (debounce ≥ 350ms)
- [ ] No UI freeze during fetch (React renders are non-blocking)

### C2. Responsive layout
- [ ] At 375px viewport: table headers hidden, rows stack vertically
- [ ] Status badge left-aligned on mobile
- [ ] Date left-aligned on mobile
- [ ] Action buttons left-aligned and full-width on mobile
- [ ] Filter pills scroll horizontally without wrapping awkwardly
- [ ] "Load more" button visible and tappable (min 44px touch target)

### C3. Touch interactions
- [ ] Filter pill tap triggers filter change without double-tap
- [ ] "Load more" tap registers on first tap
- [ ] Actions menu opens/closes with tap, closes on tap-outside

### C4. Network interruption recovery
- [ ] While loading, kill network → error state appears with "Try again" button
- [ ] Restore network, tap "Try again" → list loads correctly
- [ ] Error clears, documents appear normally
- [ ] Previously loaded documents (from earlier pages) are NOT lost on error

---

## D. SECURITY TESTS

### D1. Cursor tamper prevention
```bash
# Send a malformed cursor
curl -H "Authorization: Bearer $TOKEN" \
  "$API_BASE/documents?cursor=INVALID_BASE64!!!"
# Expected: 200 OK — treated as first page (no crash)

# Send a cursor with wrong shape
curl -H "Authorization: Bearer $TOKEN" \
  "$API_BASE/documents?cursor=$(echo '{"evil":"true"}' | base64)"
# Expected: 200 OK — cursor ignored, first page returned

# Send a cursor with a future timestamp (attempting to skip to end)
cursor=$(echo '{"ts":"2099-12-31T00:00:00Z","id":"00000000-0000-0000-0000-000000000000"}' | base64url)
curl -H "Authorization: Bearer $TOKEN" "$API_BASE/documents?cursor=$cursor"
# Expected: 200 OK, empty documents array (no docs after 2099), no error
```

### D2. Cross-user isolation
```bash
# User A fetches their cursor, User B tries to use it
CURSOR_A=$(curl -H "Authorization: Bearer $TOKEN_A" "$API_BASE/documents?limit=1" | jq -r .nextCursor)
curl -H "Authorization: Bearer $TOKEN_B" "$API_BASE/documents?cursor=$CURSOR_A"
# Expected: User B sees THEIR OWN documents, not User A's
# The cursor only contains timestamp + id — no user data embedded
# user_id is always sourced from the authenticated JWT, never the cursor
```

### D3. SQL injection via sort/status params
```bash
# Attempt SQL injection via sort parameter
curl -H "Authorization: Bearer $TOKEN" \
  "$API_BASE/documents?sort=created_at;DROP TABLE documents--"
# Expected: Whitelist rejects non-allowed sort values, uses default

curl -H "Authorization: Bearer $TOKEN" \
  "$API_BASE/documents?status=' OR '1'='1"
# Expected: Whitelist rejects, 'all' used as default
```

### D4. Search injection
```bash
# LIKE wildcards in search
curl -H "Authorization: Bearer $TOKEN" \
  "$API_BASE/documents?search=%25%25%25%25%25"
# Expected: Returns only docs matching "%%%%%", not all docs
# The backend escapes % _ \ before using in ILIKE

# Very long search string
curl -H "Authorization: Bearer $TOKEN" \
  "$API_BASE/documents?search=$(python3 -c 'print("A"*1000)')"
# Expected: Truncated to 100 chars, no error
```

### D5. Rate limiting compatibility
```bash
# Rapid pagination requests (should hit rate limiter, not error)
for i in $(seq 1 20); do
  curl -s -o /dev/null -w "%{http_code}\n" \
    -H "Authorization: Bearer $TOKEN" "$API_BASE/documents?limit=25"
done
# Expected: 200s until rate limit, then 429 — no 500s
```

### D6. Auth expiry handling
```bash
# Use an expired JWT
curl -H "Authorization: Bearer EXPIRED_TOKEN" "$API_BASE/documents"
# Expected: 401 Unauthorized

# Frontend behavior: useDocumentPagination sets error.type='auth'
# Dashboard shows "Session expired" error state
# No infinite retry loop
```

---

## E. FAILURE RECOVERY SCENARIOS

### E1. Document deleted between pages
1. User loads page 1 (docs 1–25, cursor points at doc 25)
2. Another session deletes doc 25
3. User clicks "Load more" — cursor sends `created_at` of deleted doc
4. Expected: Page 2 starts from the next doc after that timestamp
   (WHERE created_at < cursor.ts). No gap, no crash, no duplicate.

### E2. Concurrent "Load more" clicks
1. User rapidly double-clicks "Load more"
2. The button is disabled (`loadingMore = true`) after first click
3. Expected: Only one request fires — no duplicated documents in list

### E3. Filter change during in-flight fetch
1. Fetch starts for filter=all
2. User immediately switches to filter=pending
3. The hook increments requestId and aborts the previous request
4. Expected: Only pending docs appear — no "all" docs flash in briefly

### E4. Stats API failure
1. `/documents/stats` returns 500
2. Expected: Stat cards show `—` instead of a number
3. Document list continues to load normally (stats are independent)
4. No unhandled promise rejection

---

## F. PERFORMANCE BENCHMARKS

### F1. Before vs. After comparison

| Metric | Before (slice) | After (cursor pagination) |
|--------|---------------|--------------------------|
| Bytes fetched (100 docs) | ~15KB (all rows) | ~3.5KB (25 rows) |
| Bytes fetched (10k docs) | ~1.5MB (all rows!) | ~3.5KB (25 rows) |
| DB query time (10k docs) | ~200ms (full scan) | ~1ms (index scan) |
| Initial render time | Blocked on full fetch | Shows skeletons instantly |
| React array size | Grows unbounded | Max = loaded pages × 25 |
| Stats accuracy | Wrong (only first 20) | Correct (DB-computed) |

### F2. Index verification query
```sql
-- After running migration 006, verify indexes exist:
SELECT indexname, indexdef
FROM pg_indexes
WHERE tablename = 'documents'
ORDER BY indexname;

-- Expected indexes:
-- idx_documents_list_covering
-- idx_documents_name_trgm
-- idx_documents_paginate_org
-- idx_documents_paginate_primary
-- idx_documents_paginate_status
```
