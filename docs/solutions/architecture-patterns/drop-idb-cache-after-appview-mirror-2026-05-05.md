---
module: frontend/context/AppContext
date: 2026-05-05
problem_type: architecture_pattern
component: frontend_stimulus
severity: medium
applies_when:
  - "SPA with remote-first read path where server p50 has materially improved"
  - "AppContext-style central data orchestrator with multiple refresh entry points"
  - "Client cache was added to mask network latency, not for offline capability"
  - "A server-side migration (AppView, CDN, regional DB) closes the latency gap the cache covered"
  - "Two or more refresh entry points (mount, visibility, pull-to-refresh, post-mutation) can race each other"
related_components:
  - frontend_stimulus
  - database
tags:
  - idb-cache-removal
  - appview-migration
  - cursor-pagination
  - concurrent-refresh
  - optimistic-mutations
  - error-ui
  - at-protocol
  - spa-data-orchestration
---

# Drop browser IndexedDB cache when AppView becomes the fast read path

## Context

A browser-side IndexedDB cache earns its keep when the read path is slow and
unavoidably so — typically a PDS fan-out where every page load fires multiple
`listRecords` calls to a user-controlled server you cannot cache at the CDN
edge. In that regime the cache masks latency (sub-second render from local
store), hides partial failures (serve stale if PDS is momentarily unreachable),
and enables cross-device awareness (diff merge can surface "3 bookmarks added on
mobile"). The cost is real: IDB adds bundle weight (the `idb` npm dep), a
sync/diff machinery layer (~600 lines of cache code + a 191-line diff test
file), a stale-session concept with its own `localStorage` keys
(`kipclip-last-visit-${did}`), and a second failure-mode class — cache
corruption or desync.

Phases 1–3 of kipclip's AppView migration moved the read path to a Hetzner box
serving bookmarks from a local libSQL mirror. p50 dropped to sub-100 ms. At that
point the cache stopped paying rent: the latency it was masking no longer
existed, the diff-merge "N updated" cross-device toast became noise rather than
signal, and the IDB machinery was now pure drag.

Phase 4 removed it entirely: `frontend/cache/db.ts`, `sync.ts`, `diff.ts`, the
`idb` dep, the stale-session machinery, and the 191-line `tests/diff.test.ts`.
Net result: −687 lines of code, bundle 187 → 178 KB, and a substantially smaller
concurrent-refresh race surface.

The accepted regression: when the AppView is unreachable there is no stale-cache
fallback. Phase 4 explicitly chose a hard error screen + retry over a silent
empty-list render (which a stale cache could produce under desync anyway).

## Guidance

### 1. Remove a client cache immediately after the server-side speedup — don't defer

Cache-and-race debt compounds. Every day the cache lives after the speedup is
another day two failure-mode classes coexist (server errors **and** cache
desync). The diff/sync machinery does not pay for itself at sub-100 ms p50.
Remove it in the same window the server migration lands, while the context is
hot. The bundle savings (≈9 KB here) are secondary; the reduction in
concurrent-state reasoning surface is primary.

### 2. Concurrent-refresh patterns: shared in-flight guard across ALL entry points

With no local cache, every refresh entry point (mount, visibility,
pull-to-refresh, post-import) hits the network. If each entry point guards only
itself, two concurrent loads can still race. The fix is a single
`refreshInFlightRef` shared by every path that calls `fetchAndApply`:

```typescript
// AppContext.tsx — shared guard
const refreshInFlightRef = useRef(false);

async function loadInitialData() {
  if (refreshInFlightRef.current) return;
  refreshInFlightRef.current = true;
  try {
    await fetchAndApply();
  } finally {
    refreshInFlightRef.current = false;
  }
}

async function refreshData(toastId?: string | number) {
  if (refreshInFlightRef.current) return;
  refreshInFlightRef.current = true;
  try {
    await fetchAndApply((page) => {
      if (toastId) {
        toast(`Syncing bookmarks... (page ${page})`, { id: toastId });
      }
    });
    if (toastId) toast.success("Bookmarks up to date", { id: toastId });
  } catch (err) {
    if (toastId) toast.error("Refresh failed", { id: toastId });
    throw err;
  } finally {
    refreshInFlightRef.current = false;
  }
}
```

A subtlety in the visibility handler: do not claim the debounce window when a
refresh is already in flight. If you short-circuit after claiming the slot, the
user waits a full extra window for the next real refresh:

```typescript
function handleVisibilityChange() {
  if (document.visibilityState !== "visible") return;
  const now = Date.now();
  if (now - lastSyncCheckRef.current < 60_000) return;
  if (refreshInFlightRef.current) return; // guard BEFORE claiming slot
  lastSyncCheckRef.current = now;
  refreshData().catch((err) => {
    console.warn("Tab-focus sync failed:", err);
    toast.error("Sync failed");
  });
}
```

### 3. Defensive cursor-pagination: cycle detect + page ceiling; encode page-shape asymmetry in types

A server bug returning a non-advancing cursor produces an infinite loop.
Belt-and-suspenders defense:

```typescript
const MAX_PAGINATION_PAGES = 200;

while (bookmarkCursor) {
  if (bookmarkCursor === prevCursor) {
    console.warn("Pagination cursor not advancing, breaking loop", {
      cursor: bookmarkCursor,
      pageNumber,
    });
    break;
  }
  if (pageNumber >= MAX_PAGINATION_PAGES) {
    console.warn("Pagination depth ceiling reached", { pageNumber });
    break;
  }
  prevCursor = bookmarkCursor;
  pageNumber++;
  // fetch next page...
}
```

Subsequent pages of `/api/initial-data` do not re-emit
`settings / preferences / isSupporter / syncing`. Encoding that asymmetry in a
dedicated type means a mis-typed cursor loop fails to compile rather than
silently clobbering server meta:

```typescript
/**
 * Pages 2..N carry only the bookmark stream.
 * settings/preferences/isSupporter/syncing are first-response only.
 * A typo here fails to type-check rather than silently clobbering meta.
 */
interface PaginationPage {
  bookmarks: EnrichedBookmark[];
  bookmarkCursor?: string;
  annotationCursor?: string;
  rateLimit?: { remaining: number; reset: number; limit: number };
}
```

### 4. Don't silently render empty on AppView outage — error screen + retry beats stale-cache-render-with-no-signal

Without a local cache, an outage means the user sees nothing. The temptation is
to show an empty list (avoiding a red-screen moment). Resist it. An empty list
looks identical to a newly registered user with zero bookmarks; the user has no
signal that their data still exists. Surface a hard error with retry:

```tsx
// App.tsx — post phase-4 error UI
if (loadError) {
  return (
    <div className="flex flex-col items-center justify-center min-h-screen px-4 text-center">
      <p className="text-red-600 mb-2">Couldn't load your bookmarks.</p>
      <p className="text-gray-500 text-sm mb-6">{loadError}</p>
      <button
        type="button"
        onClick={runInitialLoad}
        className="px-4 py-2 rounded-lg bg-coral text-white"
        style={{ backgroundColor: "var(--coral)" }}
      >
        Try Again
      </button>
    </div>
  );
}
```

`loadInitialData` throws on any non-OK HTTP status. `runInitialLoad` catches it
and sets `loadError`, which gates this branch. Apply the same principle to
mid-pagination refresh: a stuck "Syncing... (page N)" toast is worse than an
error toast. Pass `toastId` through `refreshData` and dismiss explicitly on
failure (see Guidance §2).

### 5. Optimistic mutation tradeoffs without local persistence: TAP lag windows expose "vanishing add" races

When mutations are optimistic (add bookmark → update React state immediately,
then fire the API call), and a concurrent refresh completes while that API call
is in flight, the refreshed state from the server will not yet include the new
record (the TAP event that would trigger a mirror write has not arrived). The
result: the bookmark visually disappears, then reappears on the next refresh
cycle. This race class exists even at sub-100 ms p50 because the AT Protocol
firehose / TAP delivery window is distinct from HTTP response time.

Mitigations exist (sessionStorage write-buffer, pending-writes ref + merge on
refresh, SSE for real-time push) but each involves design tradeoffs. The key
practice: **know the window, document it explicitly, do not silently accept it
as a cache bug.** With IDB the race was hidden behind "cache wins on conflict";
without it, it surfaces in production. Track deferred mitigations explicitly in
code TODOs and project memory, not just as implicit follow-ups. (auto memory
[claude]: post-phase-4 follow-ups include SSE / WebSocket live updates as the
planned mitigation for this race class.)

## Why This Matters

Three concrete measures shift when you remove a cache that was masking latency:

**Bundle weight.** Dropping `idb` + the sync/diff layer trimmed ≈9 KB from the
production bundle (187 → 178 KB minified). That is not the main gain. The main
gain is that `deno.lock` no longer pins an npm dep that needs auditing, and
future contributors do not inherit a sync-layer mental model.

**Race surface count.** With IDB in place, a refresh could produce: (a)
network-response vs cache-read race, (b) diff-merge applying a delete to a
record already removed in React state, (c) stale-session write-through masking a
server error. All three classes vanish. The remaining race is the TAP-lag
vanishing-add (see Guidance §5), which is now visible and attributable rather
than hidden.

**What does the user see when X fails.** With cache: a stale render with no
signal (looks like everything is fine, but data is N minutes old). Without
cache: a hard error screen with a retry button and the HTTP status code surfaced
in the message body. The second failure mode is diagnostically superior even
though it is visually more alarming. If the outage is transient, the retry
button resolves it in one tap. If it is persistent, the error message gives the
user something to report.

Measure these three before deciding a cache is worth keeping. If p50 is sub-100
ms, the race surface is larger than the latency gain, and the failure UX is
"silent stale," the cache is not earning its keep.

## When to Apply

Apply this guidance when ALL of the following hold:

- The app is a React (or equivalent) SPA with a central data-orchestrator
  context that manages the full record lifecycle (load, add, update, delete,
  refresh).
- The read path recently gained a server-side speedup (AppView, regional DB,
  CDN-edge cache, read replica) that materially cut p50 — typically below 150
  ms.
- The client cache was added to mask latency, not to enable offline capability
  or local-first writes. If offline writes are a feature requirement, keep the
  cache.
- The cache has a sync/diff layer — i.e., it maintains a local state that must
  be reconciled against the server on reconnect or tab refocus.
- There are two or more refresh entry points (mount, visibility,
  pull-to-refresh, post-mutation) that could race each other.

The concurrent-refresh guard pattern (Guidance §2) applies whenever you have
multiple async entry points into a shared state-setter, regardless of whether
you are removing a cache.

The `PaginationPage` type-asymmetry pattern (Guidance §3) applies whenever a
paginated API emits metadata only on the first page — a common pattern in AT
Protocol `listRecords` and AppView cursor endpoints.

## Examples

### Cycle detection + page ceiling (`fetchInitialPaginated` inner loop)

```typescript
// frontend/context/AppContext.tsx
const MAX_PAGINATION_PAGES = 200;

while (bookmarkCursor) {
  if (bookmarkCursor === prevCursor) {
    console.warn("Pagination cursor not advancing, breaking loop", {
      cursor: bookmarkCursor,
      pageNumber,
    });
    break;
  }
  if (pageNumber >= MAX_PAGINATION_PAGES) {
    console.warn("Pagination depth ceiling reached, breaking loop", {
      pageNumber,
    });
    break;
  }
  prevCursor = bookmarkCursor;
  pageNumber++;
  onProgress?.(pageNumber);
  // ... fetch next page
}
```

### `PaginatedInitial` with optional `syncing` + normalisation at setter

```typescript
interface PaginatedInitial {
  bookmarks: EnrichedBookmark[];
  settings: UserSettings;
  preferences: UserPreferences;
  isSupporter: boolean;
  /** Mirror branch only; absent on PDS-fallback + completed mirrors. */
  syncing?: boolean;
}

function applyServerMeta(data: PaginatedInitial) {
  setSettings(data.settings);
  setIsSupporter(data.isSupporter);
  setMirrorSyncing(data.syncing ?? false); // normalize at boundary, not at call sites
  // ...
}
```

### Forward-compat dead context fields need a tripwire

```typescript
/**
 * TODO(phase4-followup): consume this in the UI as a "still syncing your
 * data" pill within 14 days of phase 4 merging (by ~2026-05-19). If the
 * follow-up slips, remove this field rather than leaving dead context
 * state. Tracking memo: memory/project_post_phase4_followups.md (item 1).
 */
mirrorSyncing: boolean;
```

A context field added without a current consumer must carry a removal tripwire —
otherwise it silently turns into permanent dead state.

## Cross-References

- **Plan:**
  [`docs/plans/2026-05-05-001-refactor-phase-4-drop-idb-cache-plan.md`](../../plans/2026-05-05-001-refactor-phase-4-drop-idb-cache-plan.md)
  — phase 4 implementation plan with full requirements (R1–R5) and
  accepted-regression rationale.
- **Origin requirement:** R22 of
  `docs/brainstorms/pds-rate-limit-appview-mirror-requirements.md`.
- **Phase-3 cutover runbook:**
  [`docs/operations/phase-3-cutover-runbook.md`](../../operations/phase-3-cutover-runbook.md)
  — the cutover that made phase 4 possible.
- **PR:**
  [#16 — refactor(frontend): drop IDB cache + sync/diff machinery (phase 4)](https://github.com/tijs/kipclip-appview/pull/16).
- **Adjacent server-side learning:**
  [`docs/solutions/performance-issues/tap-webhook-burst-timeout-storm-2026-05-03.md`](../performance-issues/tap-webhook-burst-timeout-storm-2026-05-03.md)
  — TAP webhook backpressure; orthogonal to this learning but part of the same
  migration arc.
