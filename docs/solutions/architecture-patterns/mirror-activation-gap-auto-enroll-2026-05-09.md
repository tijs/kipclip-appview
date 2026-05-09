---
title: Mirror read architecture built but never activated for users
date: 2026-05-09
category: docs/solutions/architecture-patterns/
module: mirror-read-architecture
problem_type: architecture_pattern
component: database
severity: high
applies_when:
  - Building infrastructure that is enrollment-gated before becoming the default for all users
  - Adding a feature flag or mode that silently degrades to a slower fallback for unenrolled entities
  - Writing gate-open timestamps or status markers before all data prerequisites are satisfied
  - Displaying server-supplied lists whose sort order is not formally specified by the API contract
related_components:
  - frontend_stimulus
  - development_workflow
tags:
  - mirror-read
  - auto-enrollment
  - architecture-activation
  - feature-flag
  - sort-order
  - backfill
  - tap
  - at-protocol
---

# Mirror read architecture built but never activated for users

## Context

kipclip maintains a local SQLite mirror of every tracked user's AT Protocol
bookmark data. TAP (a Go process subscribed to the AT Protocol firehose) feeds
webhook events into the mirror. Read requests for tracked DIDs are served from
the mirror at sub-millisecond latency instead of hitting the user's PDS.

The mirror read path was built and enabled in production (`MIRROR_MODE=read`)
for over a month. During that time, 94 of 95 users were served entirely from PDS
fallback — the mirror was never activated for them. Only the operator's own DID
had been manually enrolled via the operator backfill script
(`scripts/backfill-mirror.ts`). The architecture was complete; the default
population step was missing.

Two concrete bugs compounded the impact once enrollment was fixed:

1. **Empty-mirror safeguard logic inversion** — the safeguard that falls through
   to PDS when the mirror returns zero bookmarks was disabled during
   `syncing=true` state, precisely when it was most needed.
2. **New-bookmark invisibility** — the UI trusted PDS ascending rkey sort order.
   New TID-format rkeys (`3mlf...`) sort after old hex rkeys (`b89a...`) in
   ASCII order, so newly added bookmarks appeared at position 1700+ in a
   3000-bookmark library — effectively invisible.

## Guidance

**1. Treat activation as a separate milestone from implementation.**

Infrastructure is not live until it is the default for all users. When building
a tiered or enrollment-gated system, write the auto-enrollment step as a
first-class deliverable — not an operator task or a future follow-on. "Build the
mirror" and "enroll all users automatically on first request" are separate work
items; shipping only the first one means the second never ships.

**2. Implicit feature flags need observable gaps.**

When `MIRROR_MODE=read` is set but zero DIDs are tracked, the system silently
degrades. A `console.log` at startup ("MIRROR_MODE=read but 0 DIDs tracked"), an
admin health endpoint, or a metric makes the gap visible. Silent degradation in
a performance path is indistinguishable from correct behaviour unless you
instrument it.

**3. Write gate-open markers atomically with data.**

Never insert a `backfill_started_at` timestamp before the backfill is complete.
The `tracked_dids` row is the gate that routes reads to the mirror; opening the
gate before data is present creates a window where the mirror returns zero
results and no safeguard can reliably distinguish "genuinely no bookmarks" from
"backfill in progress." The correct sequence: complete the backfill, then insert
the row with both `backfill_started_at` and `backfill_complete_at` set in a
single atomic write.

**4. Safeguard conditions must cover the dangerous state, not just the safe
one.**

When writing a "fall through to the authoritative source if the fast path
returns empty" safeguard, only disable it when you can prove the fast path is
authoritative. A `syncing=true` state means the fast path is _not_ authoritative
— disabling the safeguard exactly there is a logic inversion. The condition
should be: `if (empty && !cursor)`, not `if (empty && !cursor && !syncing)`.

**5. Sort explicitly; never rely on server list order unless it is a formal API
contract.**

If the server returns items in ascending rkey order and a new key format (TID vs
hex) changes the sort, display breaks silently. Always sort display lists by a
documented stable field (`createdAt DESC`) in the UI layer, and make the sort
explicit in code so future key format changes cannot regress it.

## Why This Matters

The mirror read path was the primary performance investment for kipclip's
scalability — built to serve bookmarks at sub-ms latency and eliminate PDS load.
Because activation was never automated, 100% of real-user traffic continued
hitting PDS; the investment delivered zero production benefit for over a month.

The pattern generalises: any infrastructure that requires per-entity enrollment
before it becomes effective will silently sit unused unless enrollment is built
into the normal user journey. This is easy to miss because the operator's own
account — the most-tested path — may have been enrolled manually during
development, masking the gap for all other users.

Session history confirms that the subagent which first identified the problem
traced it through `shouldReadFromMirror` and concluded: _no users are ever
auto-tracked; the mirror is opt-in at the operator level, not automatic on
signup._ (session history)

## When to Apply

- Building a read-through cache, mirror, CDN routing, or any system where
  individual entities must be enrolled before the fast path activates.
- Adding a feature flag or environment variable that controls a performance or
  reliability mode.
- Writing a backfill script or migration that opens a gate before data is
  confirmed present.
- Displaying any server-supplied list where sort order is not formally specified
  by the API.
- Building an operator-facing management UI for a feature that should eventually
  be fully automatic.

## Examples

**Auto-enrollment on first authenticated request (`lib/auto-enroll.ts`)**

```typescript
export function autoEnrollIfNeeded(did: string, pdsUrl: string): void {
  if (getMirrorMode() !== "read") return; // no-op in off/test mode
  if (enrollingDids.has(did)) return; // prevent concurrent re-enrollment

  enrollingDids.add(did);

  (async () => {
    try {
      await tapEnroll(did).catch((err) =>
        console.warn("[auto-enroll] TAP enroll non-fatal:", err)
      );
      await runBackfill(did, pdsUrl); // fetch all 5 collections from PDS

      // Atomic gate open: both timestamps written in a single upsert.
      // The mirror gate opens only after data is confirmed present.
      const now = Date.now();
      await mirrorWrite({
        sql: `INSERT INTO tracked_dids
                (did, pds_url, added_at, backfill_started_at, backfill_complete_at, last_seq, last_event_at)
              VALUES (?, ?, ?, ?, ?, NULL, NULL)
              ON CONFLICT(did) DO UPDATE SET
                pds_url = COALESCE(tracked_dids.pds_url, excluded.pds_url),
                backfill_started_at = COALESCE(tracked_dids.backfill_started_at, excluded.backfill_started_at),
                backfill_complete_at = COALESCE(tracked_dids.backfill_complete_at, excluded.backfill_complete_at)`,
        args: [did, pdsUrl, now, now, now],
      });
    } catch (err) {
      enrollingDids.delete(did); // allow retry on next request
      captureMessage("auto-enroll failed", "error", {
        did,
        error: String(err),
      });
    }
  })();
}
```

Key design decisions surfaced during implementation (session history):

- `enrollingDids.delete(did)` in the catch block is required — without it, a PDS
  fetch failure permanently blocks retry for the lifetime of the server process.
- `upsertTrackedDid` (shared with TAP event progress) must NOT be used for
  enrollment; the split into `insertTrackedDidForEnrollment` prevents a TAP
  event arriving mid-backfill from overwriting the enrollment row's state.

**Triggering auto-enrollment on the first page load of a new user**

```typescript
// In routes/api/initial-data.ts, after shouldReadFromMirror():
if (isFirstPage && !mirrorDecision.fromMirror) {
  autoEnrollIfNeeded(oauthSession.did, oauthSession.pdsUrl ?? "");
}
```

**Correcting the empty-mirror safeguard (routes/api/initial-data.ts,
routes/api/bookmarks.ts)**

```typescript
// Before (bug): safeguard disabled when syncing=true — exactly the wrong time
if (page.bookmarks.length === 0 && !page.cursor && !mirrorDecision.syncing) {
  throw new Error("mirror_empty_fallthrough");
}

// After (fix): any tracked DID returning zero bookmarks and no cursor falls through
if (page.bookmarks.length === 0 && !page.cursor) {
  throw new Error("mirror_empty_fallthrough");
}
```

**Explicit client-side sort (`frontend/context/AppContext.tsx`)**

```typescript
// Before: return result;  — trusted PDS ascending rkey order
//
// After: sort explicitly by createdAt DESC.
// PDS fallback returns records in ascending rkey order (reverse=false default).
// TID rkeys (3ml...) sort before hex rkeys (b89a...) in ASCII, so new bookmarks
// appeared at position 1700 in a 3000-item list. Mirror reads return createdAt DESC
// already; this sort is a no-op for mirror users and a correctness fix for PDS.
return [...result].sort((a, b) =>
  (b.createdAt ?? "").localeCompare(a.createdAt ?? "")
);
```

**One-shot operator backfill (`scripts/backfill-mirror.ts`)**

For existing users who need to be enrolled outside the automatic path:

```bash
DATABASE_URL=file:/var/lib/kipclip/kipclip.db \
  DID=did:plc:... \
  deno run --allow-all --config deno.json scripts/backfill-mirror.ts
```

The script: resolves DID doc from `plc.directory` → paginates all 5 collections
from PDS → upserts into mirror tables → stamps `backfill_complete_at`.

## Related

- `docs/solutions/performance-issues/tap-webhook-burst-timeout-storm-2026-05-03.md`
  — The `scripts/backfill-mirror.ts` one-shot script is the formalised version
  of the "re-track the DID" operational step documented in that doc's prevention
  rules.
- `docs/solutions/architecture-patterns/drop-idb-cache-after-appview-mirror-2026-05-05.md`
  — The `syncing: boolean` flag documented there as a "dead context field" is
  now live — users going through auto-enrollment will transiently see
  `syncing: true` if they trigger a request while the background backfill is in
  progress (rare, since backfill runs to completion before the gate opens). The
  tripwire comment in that doc's Guidance §3 should be marked resolved.
