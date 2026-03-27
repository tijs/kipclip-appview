---
title: "refactor: Simplify sync to first-page diff"
type: refactor
status: active
date: 2026-03-27
origin: docs/brainstorms/2026-03-27-simplified-sync-brainstorm.md
---

# Simplify Sync to First-Page Diff

## Overview

Replace the current hash-based change detection + full resync with a first-page
diff that patches the IndexedDB cache surgically. The current system has two
problems: (1) the sync hash can desync from the cache causing missed updates,
and (2) any detected change triggers a full re-fetch of all 3000+ bookmarks,
burning through the PDS rate limit (~300 req/5min).

The new approach: on every tab focus, fetch the first page of bookmarks (100
newest records, 2-3 PDS calls). Compare URIs+CIDs against the cached records.
Merge additions, patch edits. Never re-fetch everything automatically.

(See brainstorm: `docs/brainstorms/2026-03-27-simplified-sync-brainstorm.md`)

## Problem Statement

1. **Sync hash desync** — localStorage hash and IndexedDB cache can get out of
   sync, causing kipclip to think nothing changed when new bookmarks exist
2. **Full resync on any change** — when a change is detected, we re-fetch ALL
   bookmarks (30+ PDS calls), exhausting the rate limit in one shot
3. **Unnecessary complexity** — separate `/api/sync-check` endpoint, hash
   computation, incremental pagination with early-exit, cache version
   migrations, `loadWithCache`/`SyncResult` abstractions
4. **Race condition** — concurrent mutation + background sync: if user adds a
   bookmark while sync is running, `setBookmarks(merged)` overwrites the
   optimistic addition because the merge uses the stale cache snapshot, not the
   current React state (AppContext.tsx ~line 282)

## Proposed Solution

### Tab-focus sync (the common case)

```
visibilitychange (debounced 60s)
  → GET /api/initial-data (first page: 100 bookmarks + annotations + all tags)
  → diffFirstPage(serverBookmarks, cachedBookmarks):
      new URIs       → add to cache + state
      changed CIDs   → update in cache + state
      missing URIs   → ignore (caught on manual refresh)
  → replace tags in cache (small collection, always full-fetch)
  → animate refresh icon during sync
```

Cost: 3-4 PDS calls regardless of whether anything changed. Same as the current
`sync-check` hash endpoint, but without the hash desync risk.

### Manual refresh (rare, user-triggered)

```
pull-to-refresh or refresh button
  → paginate ALL pages in background, very slowly
  → pause when rateLimit.remaining < 50, wait until reset
  → collect full bookmark set
  → clear-and-replace entire cache (catches deletions)
  → update UI state
  → animate refresh icon + show progress ("Syncing... 1200/3000")
```

### Cold start (first visit or cleared cache)

Same as manual refresh but triggered automatically. Fetch first page, render
immediately (user sees 100 bookmarks), paginate rest in background. Show loading
indicator below list. Search works on loaded bookmarks only until complete.

### Same-device mutations (unchanged)

Optimistic local update + fire-and-forget IndexedDB write. No sync needed.

## Technical Considerations

### Cache write strategy change

The current `putBookmarks()` in `db.ts` does **clear-and-replace** (clears the
entire objectStore, re-writes everything). This must change:

- **Tab-focus sync**: incremental upsert — `putBookmark(b)` for new/changed
  records only. Never delete from cache during tab-focus sync.
- **Manual refresh + cold start**: keep clear-and-replace — this is the only
  path that catches deletions.

### Merge must use current React state, not stale snapshot

The current code merges against `immediate.bookmarks` (the cache snapshot from
when `loadWithCache` ran). If the user mutated bookmarks during the sync, those
changes are lost. The new merge must read the current `bookmarks` state at merge
time via a ref.

### Annotation-only changes

Annotations (notes, enrichment) are separate AT Protocol records. Changing a
note does NOT change the bookmark's CID. This means annotation-only edits on
another device are **not detected** by the first-page diff. Accepted limitation
— caught on manual refresh.

### Bulk additions safeguard

If another device added 100+ bookmarks, ALL cached first-page records appear
"missing" from the server's first page. This is NOT mass deletion — it's new
records pushing old ones down. The diff function should detect this (most/all
first-page records are new) and skip any deletion heuristics entirely.

### Tags

Tags are a small collection (tens of records). Always full-fetch via
`listAllRecords` on every sync. Already happens in the current
`/api/initial-data` endpoint (line 123). No change needed.

## Acceptance Criteria

### Core sync

- [ ] Tab focus fetches first page and merges new/changed bookmarks into cache
- [ ] Tab focus never triggers full re-pagination
- [ ] Same-device mutations still work via optimistic updates
- [ ] Tags are fully refreshed on every tab-focus sync
- [ ] Refresh icon animates during ALL sync/background work

### Manual refresh

- [ ] Pull-to-refresh / refresh button triggers full paginated refresh
- [ ] Pagination pauses when PDS rate limit is low
- [ ] Progress indicator shows during refresh ("Syncing... 1200/3000")
- [ ] Cache is fully replaced on completion (catches deletions)

### Cold start

- [ ] First visit renders first page immediately (no blank screen)
- [ ] Remaining pages load in background with rate-limit respect
- [ ] Loading indicator shows while background pagination is in progress
- [ ] Cache is populated on completion

### Cleanup

- [ ] `/api/sync-check` endpoint removed
- [ ] `computeSyncHash()` removed
- [ ] `checkForChanges()` removed
- [ ] `saveSyncHash()` / `getSyncMeta("lastSyncHash")` removed
- [ ] `loadWithCache()` / `SyncResult` type simplified or removed
- [ ] Sync hash localStorage keys removed
- [ ] Cache version migration code removed (no longer needed)
- [ ] `[sync]` debug logging removed from AppContext.tsx and sync.ts

### Race condition fix

- [ ] Concurrent mutation + background sync does not overwrite optimistic
      updates
- [ ] Merge uses current React state (via ref), not stale cache snapshot

## Implementation Phases

### Phase 1: New cache primitives + diff function

**Files:** `frontend/cache/db.ts`, new `frontend/cache/diff.ts`

- [ ] Add `getCachedBookmarkMap(): Promise<Map<string, {uri, cid}>>` to db.ts —
      returns URI→CID map for diffing (or reuse `getCachedBookmarks()` and build
      map in caller)
- [ ] Add `upsertBookmarks(bookmarks: EnrichedBookmark[]): Promise<void>` to
      db.ts — adds/updates without clearing the store
- [ ] Create `diffFirstPage(server, cached)` function that returns
      `{additions: EnrichedBookmark[], updates: EnrichedBookmark[]}` by
      comparing URI+CID tuples
- [ ] Add tests for diff function: additions, edits, no changes, bulk additions,
      empty cache, empty server response

### Phase 2: Simplify tab-focus sync

**Files:** `frontend/context/AppContext.tsx`, `frontend/cache/sync.ts`

- [ ] Replace `loadInitialData` with simpler flow: fetch first page → diff →
      upsert cache → merge into current state (via ref)
- [ ] Tab-focus handler calls the same function (no separate `checkForChanges`)
- [ ] Fix race condition: merge against current `bookmarks` ref, not stale
      snapshot
- [ ] Add `isSyncing` state for refresh icon animation
- [ ] Keep 60s debounce on tab-focus sync

### Phase 3: Rate-limit-aware background pagination

**Files:** `frontend/cache/sync.ts`, `frontend/context/AppContext.tsx`

- [ ] Extract `paginateAll(firstPageData)` function that fetches all remaining
      pages with rate-limit-aware pausing
- [ ] Add `syncProgress` state: `{current: number, total: number} | null`
- [ ] Wire up to manual refresh trigger (pull-to-refresh + refresh button)
- [ ] On completion: clear-and-replace entire cache (full reconciliation)
- [ ] Wire up cold-start path: render first page immediately, paginate in
      background, update state as pages arrive

### Phase 4: Remove dead code

**Files:** `routes/api/initial-data.ts`, `frontend/cache/sync.ts`,
`frontend/cache/db.ts`, `frontend/context/AppContext.tsx`, `shared/types.ts`

- [ ] Remove `/api/sync-check` endpoint
- [ ] Remove `computeSyncHash()` from initial-data.ts
- [ ] Remove extra `listOnePage(TAG_COLLECTION)` call (line 124) that was only
      for sync hash — saves 1 PDS call per first-page load
- [ ] Remove `syncHash` field from `InitialDataResponse` type
- [ ] Remove `checkForChanges()`, `saveSyncHash()` from sync.ts
- [ ] Remove `getSyncMeta` / `setSyncMeta` if no longer used
- [ ] Remove sync hash localStorage keys and `clearSyncHash()` from db.ts
- [ ] Remove `CACHE_VERSION` migration code from db.ts
- [ ] Remove `[sync]` debug console.log statements
- [ ] Remove todo `001-pending-p1-sync-check-unbounded-tag-pagination.md`
      (problem eliminated)

### Phase 5: UI feedback

**Files:** `frontend/components/BookmarkList.tsx`, `frontend/components/App.tsx`

- [ ] Animate refresh icon when `isSyncing` is true
- [ ] Show progress bar/text during manual refresh and cold-start pagination
- [ ] Show "Loading more bookmarks..." below list during cold-start background
      pagination
- [ ] Handle zero-bookmarks edge case (server returns empty → clear cache)

## Edge Cases

| Case                                     | Behavior                                                                           |
| ---------------------------------------- | ---------------------------------------------------------------------------------- |
| First-page fetch fails (network/500/429) | Keep cache as-is, show no error (silent retry on next focus)                       |
| IndexedDB unavailable                    | Fall back to fetch-only mode (no cache, no diff — same as current `dbFailed` path) |
| User switches accounts                   | Per-DID database isolation already handles this                                    |
| Pagination fails mid-way (cold start)    | Show partial data, set `complete = false`, indicate incomplete load                |
| All bookmarks deleted on another device  | Server returns 0 bookmarks → clear local cache                                     |
| Rapid tab focus                          | 60s debounce prevents multiple syncs                                               |
| Manual refresh during background sync    | Guard with `refreshInFlightRef` (existing pattern)                                 |
| Concurrent mutation + sync               | Merge against current state ref, not stale snapshot                                |

## Sources & References

- **Origin brainstorm:**
  [docs/brainstorms/2026-03-27-simplified-sync-brainstorm.md](../brainstorms/2026-03-27-simplified-sync-brainstorm.md)
  — Key decisions: first-page diff over hash check, manual refresh for deep
  changes, rate-limit-aware pagination, keep IndexedDB cache
- `frontend/context/AppContext.tsx` — current `loadInitialData` (line 226),
  tab-focus handler (line 361), race condition (line 282)
- `frontend/cache/sync.ts` — `loadWithCache` (line 38), `checkForChanges` (line
  154), `loadRemainingPages` (line 72)
- `frontend/cache/db.ts` — `putBookmarks` clear-and-replace (line 132), sync
  metadata (line 203)
- `routes/api/initial-data.ts` — `computeSyncHash` (line 30), sync-check
  endpoint (line 253)
- `lib/route-utils.ts` — `listOnePage` (line 143), `listAllRecords` (line 175)
- `todos/001-pending-p1-sync-check-unbounded-tag-pagination.md` — eliminated by
  removing sync-check entirely
