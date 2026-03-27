# Simplified Sync: First-Page Diff

## What We're Building

Replace the current sync system (hash-based change detection + full resync) with
a simpler first-page diff approach that detects and patches changes
incrementally without ever re-fetching all records.

### The Problem Today

1. **Sync hash desync bugs** — localStorage hash and IndexedDB cache can get out
   of sync, causing kipclip to think nothing changed when it did
2. **Full resync on any change** — when a change IS detected, we re-fetch all
   3000+ bookmarks (30+ PDS calls), burning through the ~300 req/5min rate limit
3. **Unnecessary complexity** — separate sync-check endpoint, hash computation,
   incremental pagination with early-exit, cache version migrations

### Why This Approach

AT Protocol gives us exactly what we need for cheap change detection:

- `listRecords(reverse=true, limit=100)` returns the 100 newest records
- Each record has a `uri` (identity) and `cid` (content hash that changes on
  edit)
- TIDs (record keys) are timestamp-based — new records always appear on page 1
- Comparing first-page URIs+CIDs against cached records catches additions,
  recent edits, and recent deletions in 2-3 PDS calls

## Key Decisions

### 1. First-page diff on tab focus (not hash check)

On app open or tab return, fetch the first page of data from the server (same
`/api/initial-data` endpoint, ~2-3 PDS calls). Compare against cached records:

- **New URI** -> addition, add to IndexedDB cache
- **Same URI, different CID** -> edit, update in IndexedDB cache
- **URI was in cached first page but now missing** -> could be a deletion OR
  pushed off page 1 by new records. Skip individual verification — if many
  records appear "missing" it's likely bulk additions, not bulk deletions.
  Deletions are caught on manual refresh.

**Safeguard against bulk additions:** If the majority of cached first-page
records are missing from the server's first page, this indicates bulk additions
(not bulk deletions). In this case, just merge the new records and skip deletion
detection entirely. This prevents mass `getRecord` calls from blowing the rate
limit.

This eliminates the separate `/api/sync-check` endpoint, the sync hash, and all
hash-cache desync bugs.

### 2. Manual refresh for deep changes

Edits/deletions beyond the first 100 records are only synced on manual refresh
(pull-to-refresh or refresh button). This is acceptable because:

- Same-device changes are already reflected via local optimistic updates
- Cross-device edit/delete of old records is rare
- Avoids any background full-scan PDS cost

### 3. Rate-limit-aware manual refresh

When the user triggers a manual refresh:

- Fetch pages in background, very slowly
- Respect PDS rate limits: pause when `rateLimit.remaining` gets low
- Show progress indicator ("Refreshing... 1200/3000")
- Animate the refresh icon during ALL background/sync work (tab-focus diff,
  manual refresh, background pagination)
- On completion: swap entire cache with fresh data (clean re-baseline)

### 4. Tag sync

Tags are a small collection (typically tens, not thousands). Always do a full
fetch of all tags on tab focus alongside the bookmark first-page diff. This is
cheap (1-2 PDS calls for the full set) and keeps tags perfectly in sync.

### 5. Cold start (empty cache)

On first visit or after cache clear: fetch first page, render immediately, then
paginate remaining pages in background with rate-limit-aware throttling. Same as
manual refresh but triggered automatically. No special-case code needed.

### 6. Keep IndexedDB cache

The cache is essential because:

- PDS has no search/filter capability on records
- Search must work across ALL bookmarks, not just the loaded page
- Cache enables instant app open (no waiting for PDS)
- Without cache, every visit requires re-fetching everything

### 7. Drop sync-check endpoint and sync hash

The `/api/sync-check` endpoint and all hash-related code (computation, storage,
comparison) can be removed. The first-page diff replaces all of it with a
simpler, more reliable mechanism.

## PDS Call Budget

| Scenario                   | PDS calls | vs. today                    |
| -------------------------- | --------- | ---------------------------- |
| Tab focus, no changes      | 3-4       | same (bkmks+annot+tags)      |
| Tab focus, 1 new bookmark  | 3-4       | was 30+ (full sync)          |
| Tab focus, bulk additions  | 3-4       | was 30+ (no deletion checks) |
| Cold start (first visit)   | ~60       | same, but throttled          |
| Manual full refresh (3000) | ~60       | same, but throttled          |

Note: "3-4 PDS calls" = 1 bookmark page + 1 annotation page + 1-2 tag pages
(tags are small so often 1 page covers all).

## What Changes

### Remove

- `/api/sync-check` endpoint
- `computeSyncHash()` server function
- `checkForChanges()` client function
- `saveSyncHash()` / sync hash localStorage
- Full-resync-on-change logic in `loadRemainingPages`
- `loadWithCache` / `SyncResult` complexity

### Simplify

- `loadInitialData` in AppContext: fetch first page, diff against cache, patch
- Tab-focus handler: just call loadInitialData again (it's idempotent now)
- Cache write: surgical put/delete instead of full replace

### Add

- `diffFirstPage(serverRecords, cachedRecords)` — returns adds/edits (simple Set
  comparison of `(uri, cid)` tuples)
- Manual refresh trigger (button or pull-to-refresh)
- Rate-limit-aware background pagination for manual refresh and cold start
- Animated refresh icon during any sync/background work
- Progress indicator for manual refresh ("Refreshing... 1200/3000")

## Resolved Questions

- **How to handle bulk additions?** Skip deletion detection when many first-page
  records are missing — it's new records pushing old ones down, not deletions.
- **What about tags?** Always full-fetch (small collection, 1-2 PDS calls).
- **Cold start?** Same as manual refresh — paginate with rate limit respect.
- **Manual refresh reconciliation?** Full cache swap after all pages arrive
  (clean re-baseline).
