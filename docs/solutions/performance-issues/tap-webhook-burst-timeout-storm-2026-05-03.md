---
title: TAP webhook timeout storm during backfill
date: 2026-05-03
category: docs/solutions/performance-issues/
module: mirror
problem_type: performance_issue
component: background_job
symptoms:
  - "TAP outbox stuck at 4800+ events; logs repeating 'webhook failed, retrying ... context deadline exceeded (Client.Timeout exceeded while awaiting headers)'"
  - "Mirror tables filling correctly (3094 bookmarks, 1724 tags) while TAP cursor never advanced — writes succeeding but acks never arriving"
  - "kipclip Deno process climbed to 1.1GB RSS and became unresponsive under burst"
  - "Manual single curl to /api/sync/hook returned 200 in 224ms; concurrent burst hung the same endpoint past 15s"
  - "First-time backfill of ~7800 records (bookmarks + annotations + tags) never converged"
root_cause: async_timing
resolution_type: code_fix
severity: high
related_components:
  - database
  - tooling
tags:
  - tap
  - webhook
  - mirror
  - libsql
  - turso
  - backpressure
  - async-ack
  - idempotency
---

# TAP webhook timeout storm during backfill

## Problem

During first-time TAP backfill of a tracked DID (~7800 records), TAP's outbox
dispatched hundreds of concurrent webhook POSTs to the Deno mirror at
`/api/sync/hook`. Serialized libSQL/Turso writes queued past TAP's hardcoded 30s
`http.Client` timeout, so TAP never received acks and retried forever even
though writes were succeeding.

## Symptoms

- TAP outbox depth frozen at exactly 4800 events across consecutive 30-second
  polls (no forward progress)
- TAP logs flood with
  `WARN webhook failed, retrying ... context deadline exceeded (Client.Timeout exceeded while awaiting headers)`,
  retries climbing past 6, 8, 10 for the same event ids
- Mirror table counts steadily grow (e.g. 3094 bookmarks observed mid-storm) —
  confirming writes succeeded server-side, only acks were missing
- `ss -tn | grep -c ":443"` shows ~22 concurrent open connections to Turso
  during the stuck period — connection-pool queueing on the libSQL HTTP path
- Manual single-event probe via `curl` returns 200 in <250ms; under TAP burst
  the same handler never returns

## What Didn't Work

- **Rewriting the webhook payload parser.** Initially assumed batched
  `{events:[]}` shape; reading `cmd/tap/types.go` confirmed TAP sends one
  `MarshallableEvt` per POST. Rewrite was correct + necessary, but didn't
  address the timeout — webhooks were already parsing and writing successfully.
- **Fixing the TAP control API path.** Real endpoint is `POST /repos/add` on
  `:2480`, not `/admin/track` on `:7000`. Required for tracking but unrelated to
  the burst-timeout symptom.
- **Restarting the Deno process.** Cleared a stuck state and made manual probes
  work, but TAP's retry storm immediately re-hung it within seconds; outbox was
  back to 4807 fifteen seconds after restart.
- **Looking for a TAP throttling knob.** `cmd/tap/outbox.go` `sendEvent` fires
  `go o.webhook.Send(...)` per pending event with no concurrency cap; the 30s
  timeout on `&http.Client{Timeout: 30 * time.Second}` is compiled in. No env
  var, no config knob — would require rebuilding TAP from source.
- **Waiting for the outbox to self-clear.** With synchronous ack semantics there
  is no natural recovery path: the burst never decays, since TAP keeps retrying
  every event that didn't ack within 30s, which is all of them.

## Solution

Added an env-flagged async-ack mode in `worker/webhook.ts` so the receiver
returns 200 immediately and processes the event in a `queueMicrotask`.
Idempotent `INSERT ... ON CONFLICT(uri) DO UPDATE` upserts make at-least-once
delivery safe.

```ts
const ACK_ASYNC = Deno.env.get("MIRROR_WEBHOOK_ACK_ASYNC") === "1";

export async function handleWebhookRequest(req: Request): Promise<Response> {
  let body: MarshallableEvt;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (ACK_ASYNC) {
    // Ack immediately so TAP advances its outbox cursor; process in background.
    // Required during backfill when burst load + Turso latency exceeds TAP's
    // 30s webhook timeout. Idempotent upserts make at-least-once writes safe;
    // event loss on Deno crash is acceptable since owner can re-track.
    queueMicrotask(() => {
      processEvent(body).catch((err) => {
        console.error("[webhook] async dispatch error", err);
        captureError(err as Error, { event: body });
      });
    });
    return Response.json({ id: body.id, type: body.type, applied: true });
  }

  try {
    const result = await processEvent(body);
    return Response.json(result);
  } catch (err) {
    console.error("[webhook] dispatch error", err);
    captureError(err as Error, { event: body });
    return Response.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
```

Set `MIRROR_WEBHOOK_ACK_ASYNC=1` in `/etc/kipclip/env` on the box. After
redeploy, the outbox drained 4800 → 0 in ~20 seconds and the mirror matched the
PDS within ~90 seconds.

`queueMicrotask` was chosen over `setTimeout(fn, 0)` or a heavyweight job queue:
it fires after the response is handed to the runtime but before any further I/O
callbacks, no extra dependency, and Deno's V8 microtask queue has the right
ordering semantics for our needs.

## Why This Works

TAP's outbox dispatches one goroutine per pending event with no concurrency cap
and waits up to 30s per call for response headers. Per-DID `DIDWorker.run()`
serializes ack handling — one slow Turso write holding up the ack freezes the
entire outbox for that DID until backoff resets.

The mirror is a downstream read replica fed by an idempotent stream. Order
doesn't matter (every record carries its own URI as primary key) and replay is a
no-op (`ON CONFLICT(uri) DO UPDATE`). Because correctness doesn't depend on ack
ordering or atomicity with persistence, decoupling ack from write transforms the
synchronous bottleneck (every write fights the same Turso HTTP connection within
TAP's 30s window) into an immediate ack plus best-effort background drain.

TAP's cursor advances; the outbox drains; worst-case failure (Deno crash
mid-microtask) loses at most a handful of events that the operator can replay by
re-tracking the DID — already the standard backfill operation.

**Delivery semantics shift, honestly stated.** With sync ack the system is
at-least-once from TAP all the way through the mirror write. With async ack the
system is **at-most-once from TAP's perspective once the ack returns** — TAP
considers the event delivered, but the microtask may still fail. Idempotency
keeps replays safe; durability falls back to the operational re-track path. This
is the right trade-off only because the mirror is regeneratable from the PDS at
any time.

## Prevention

- Treat any new webhook receiver fronting a remote DB as latency-coupled to the
  sender's timeout. Document the upstream timeout next to the receiver. TAP's is
  30s, hardcoded in `cmd/tap/outbox.go`.
- Add a load test that POSTs N concurrent events to `/api/sync/hook` with
  `N >= expected backfill size for one DID` and asserts both p99 response time
  stays well under 30s **and** RSS stays under a defined ceiling. Async ack
  uncaps in-flight concurrency, so memory bounding is now the new pressure
  point.
- Log webhook handler latency; alert if p95 exceeds ~5s — early warning before
  TAP timeouts manifest as a stuck outbox.
- During TAP integration, monitor outbox depth alongside mirror table row
  counts. Divergence (rows growing, queue not draining) is the canonical
  signature of this class of bug.
- Async-ack does NOT fix in-process memory pressure: 7800 parsed payloads held
  in microtask closures pushed Deno RSS to 1.1GB during the original storm. If
  burst sizes grow, add a bounded in-process queue / semaphore around
  `processEvent` so concurrency caps at, say, 32 in-flight Turso writes; shed
  load (return 429) when the queue exceeds a threshold so TAP backs off
  naturally.
- Default `MIRROR_WEBHOOK_ACK_ASYNC=1` for any deployment backed by remote
  libSQL (Turso). Only disable when the mirror DB is local/embedded and writes
  are sub-millisecond.
- The `MIRROR_WEBHOOK_ACK_ASYNC` flag is meant to be transient/operational, not
  architectural. Once the mirror DB moves to embedded libSQL on the box (phase
  3), sync mode becomes viable again and full ack semantics return without code
  changes.

### Known follow-up cleanups (out of scope of this fix)

These were flagged during review of the shipped code but kept off the hot path
so the fix could land minimally:

- **Trust-boundary parsing.** `req.json()` is cast to `MarshallableEvt` without
  validation. Replace with parse-to-`unknown` + small type-guard before handing
  to `processEvent`. The async branch echoes `body.id` / `body.type` in the
  response and dispatches on `body.type`, so structural validation matters.
- **Drop `| string` from discriminated unions.**
  `MarshallableEvt.type: "record" | "identity" | string` and
  `RecordEvt.action: "create" | "update" | "delete" | string` collapse to
  `string` and defeat exhaustiveness — drop the widening, handle unknown values
  via the existing default-`applied:false` branch.
- **`captureError(err as Error, ...)` casts unconditionally.** Wrap with
  `err instanceof Error ? err : new Error(String(err))` or change
  `captureError`'s signature to accept `unknown`.
- **Tests missing.** No test asserts the ACK_ASYNC=1 path returns 200 quickly
  even when `processEvent` throws (the whole point of async ack). No test for
  malformed JSON body or `{type, no record/identity}` shape.

## Related Issues

- `docs/plans/2026-05-02-001-feat-appview-mirror-phases-0-2-plan.md` — line 114
  establishes the idempotency-on-`(uri, cid)` rule that this fix depends on.
  Line 134's open question on TAP webhook ordering / batch vs single is now
  partially answered (single event per POST, ack semantics critical under
  burst).
- `docs/brainstorms/pds-rate-limit-appview-mirror-requirements.md` — R7
  (idempotent upserts), R8 (TAP firehose), R23 (localhost-only webhook).
- Fix commit: `f57a781` on branch `feat/appview-mirror`.
- TAP source reference: `cmd/tap/outbox.go`
  (`http.Client{Timeout: 30 * time.Second}`, `sendEvent` per-event goroutine
  dispatch, `DIDWorker.run` per-DID serial ack model).
