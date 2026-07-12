/**
 * Background auto-enrollment for new users.
 *
 * Triggered fire-and-forget from /api/initial-data on first request by an
 * untracked DID. Runs the full PDS backfill, then inserts the tracked_dids
 * row with BOTH timestamps set atomically so the user never sees a "syncing"
 * state with 0 bookmarks — the mirror gate opens only after data is ready.
 */

import {
  fetchLiveRepo,
  fetchWithTimeout,
  ListRecordsError,
  type LiveUris,
  upsertLiveRepo,
} from "./mirror-sync.ts";
import { getSyncStatus } from "../mirror/queries.ts";
import { db } from "./db.ts";
import { getMirrorMode } from "./mirror-config.ts";
import { resolveCurrentPds } from "./pds-migration-guard.ts";
import { captureMessage } from "./sentry.ts";

const TAP_CONTROL_URL = Deno.env.get("TAP_CONTROL_URL") ??
  "http://127.0.0.1:2480";
// TAP requires Basic auth (admin:<password>) on all endpoints including
// outbound webhook delivery. Read from the same env var TAP uses.
// Read at call time, not module load, so tests can toggle the value
// without re-importing.
function tapAdminPassword(): string | undefined {
  return Deno.env.get("TAP_ADMIN_PASSWORD");
}

// TAP /repos/add is a single in-process call to a local process on the box
// (low ms in practice). The PDS-side listRecords budget lives in mirror-sync.
const TAP_FETCH_TIMEOUT_MS = 10_000;

// Per-DID cooldown so a sustained TAP/PDS outage doesn't produce one Sentry
// event per page-load per user. After a failure, skip silently for the
// cooldown window — the user's next request beyond the window retries.
const RETRY_COOLDOWN_MS = 30_000;
const MISSING_REPO_RETRY_COOLDOWN_MS = 60 * 60 * 1000;
const retryAfter = new Map<string, number>();

// Prevents concurrent enrollment attempts for the same DID within one
// server process lifetime. A second request during the background run is a
// no-op; the DID gets tracked before the next login cycle completes.
const enrollingDids = new Set<string>();

// TAP /repos/add is verified idempotent (200 on duplicate). Retrying after
// a successful enroll but failed downstream step is safe.
export async function tapEnroll(did: string): Promise<void> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  const secret = tapAdminPassword();
  if (secret) {
    headers.Authorization = "Basic " + btoa(`admin:${secret}`);
  }
  const r = await fetchWithTimeout(
    `${TAP_CONTROL_URL}/repos/add`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({ dids: [did] }),
    },
    TAP_FETCH_TIMEOUT_MS,
  );
  if (!r.ok) throw new Error(`TAP /repos/add returned ${r.status}`);
}

/**
 * Enroll-time backfill: fetch every tracked collection from the PDS and
 * upsert it into the mirror. Upsert-only — it never removes mirror rows, so
 * it heals missing records but not stale ones. The reconciling sync
 * (lib/reconcile.ts) is the authoritative repair that also deletes.
 * Returns the live URI sets for callers that need them (reconcile reuses
 * this to compute the delete-missing complement without a second fetch).
 */
export async function runBackfill(
  did: string,
  pdsUrl: string,
): Promise<LiveUris> {
  const repo = await fetchLiveRepo(pdsUrl, did);
  return await upsertLiveRepo(did, repo);
}

/**
 * Run a single enrollment cycle: TAP enroll → backfill → mark tracked.
 * `stage` tags the captured error so operators can tell which step failed.
 * TAP-enrolled-but-backfill-failed is a recoverable state — TAP relays
 * live events for the DID; the next call beyond the cooldown retries from
 * tapEnroll (idempotent) and listRecords re-upserts any orphan rows the
 * webhook wrote in the meantime (upserts are ON CONFLICT idempotent too).
 */
async function runEnrollment(did: string, pdsUrl: string): Promise<void> {
  // Already enrolled? Short-circuit before the expensive PDS backfill.
  // Not every call site gates on tracked status — POST /api/bookmarks fires
  // unconditionally so /save-path users still get tracked — so an
  // already-tracked user adding a bookmark would otherwise re-run a full
  // 5-collection listRecords sweep against their PDS on every write, and a
  // slow PDS would time out and raise a spurious "auto-enroll failed". This
  // guard matches the `fromMirror` condition (tracking && backfill started);
  // the tracked_dids row is only written after a successful enroll, so its
  // presence means TAP enroll + backfill already completed. Pre-`try` so a
  // DB hiccup here doesn't masquerade as an enroll failure.
  const existing = await getSyncStatus(did);
  if (existing.tracking && existing.backfillStartedAt !== null) {
    retryAfter.delete(did);
    return;
  }

  let enrollmentPdsUrl = pdsUrl;
  let canonicalPdsConfirmed = false;
  let stage: "tapEnroll" | "backfill" | "trackedDids" = "tapEnroll";
  try {
    console.log(`[auto-enroll] starting for ${did}`);
    await tapEnroll(did);
    const resolved = await resolveCurrentPds(did);
    if (resolved?.pdsUrl) {
      enrollmentPdsUrl = resolved.pdsUrl;
      canonicalPdsConfirmed = true;
    }
    stage = "backfill";
    await runBackfill(did, enrollmentPdsUrl);
    stage = "trackedDids";
    const now = Date.now();
    await db.execute({
      sql: `
        INSERT INTO tracked_dids
          (did, pds_url, added_at, backfill_started_at, backfill_complete_at, last_seq, last_event_at)
        VALUES (?, ?, ?, ?, ?, NULL, NULL)
        ON CONFLICT(did) DO UPDATE SET
          pds_url = excluded.pds_url,
          backfill_started_at = COALESCE(tracked_dids.backfill_started_at, excluded.backfill_started_at),
          backfill_complete_at = COALESCE(tracked_dids.backfill_complete_at, excluded.backfill_complete_at)
      `,
      args: [did, enrollmentPdsUrl, now, now, now],
    });
    retryAfter.delete(did);
    console.log(`[auto-enroll] complete for ${did}`);
  } catch (err) {
    const canonicalRepoMissing = canonicalPdsConfirmed &&
      err instanceof ListRecordsError &&
      (err.status === 400 || err.status === 404) &&
      /repo(?:sitory)?notfound|could not find repo/i.test(err.detail);
    retryAfter.set(
      did,
      Date.now() +
        (canonicalRepoMissing
          ? MISSING_REPO_RETRY_COOLDOWN_MS
          : RETRY_COOLDOWN_MS),
    );
    captureMessage(
      "auto-enroll failed",
      canonicalRepoMissing ? "warning" : "error",
      {
        did,
        stage,
        pdsUrl: enrollmentPdsUrl,
        canonicalPdsConfirmed,
        error: String(err),
      },
    );
    const message = `[auto-enroll] failed for ${did} at ${stage}:`;
    if (canonicalRepoMissing) console.warn(message, err);
    else console.error(message, err);
    throw err;
  }
}

/**
 * Internal: kick off enrollment and clean up Set state. Returns the
 * enrollment promise so tests can await stable state. Production callers
 * use `autoEnrollIfNeeded` which discards the promise.
 */
function startEnrollment(did: string, pdsUrl: string): Promise<void> {
  enrollingDids.add(did);
  return runEnrollment(did, pdsUrl)
    .catch(() => {
      /* already captured in runEnrollment */
    })
    .finally(() => {
      enrollingDids.delete(did);
    });
}

/**
 * Fire-and-forget. Call from request handlers with no await.
 * Safe to call multiple times — the enrollingDids Set prevents duplicates
 * and a short per-DID cooldown prevents retry storms under TAP/PDS outage.
 */
export function autoEnrollIfNeeded(did: string, pdsUrl: string): void {
  if (getMirrorMode() !== "read") return;
  if (enrollingDids.has(did)) return;
  const retryAt = retryAfter.get(did);
  if (retryAt && Date.now() < retryAt) return;
  void startEnrollment(did, pdsUrl);
}

/** Test-only — await the in-flight enrollment for a DID, if any. */
export function _runEnrollmentForTest(
  did: string,
  pdsUrl: string,
): Promise<void> {
  if (enrollingDids.has(did)) {
    // Already started by a prior autoEnrollIfNeeded — no easy hook, just
    // poll until the Set clears. Tests use this only when they call
    // autoEnrollIfNeeded immediately before; a short poll is acceptable.
    return new Promise((resolve) => {
      const tick = () => {
        if (!enrollingDids.has(did)) resolve();
        else setTimeout(tick, 5);
      };
      tick();
    });
  }
  return startEnrollment(did, pdsUrl);
}

/** Test-only — clear in-process state between test cases. */
export function _resetAutoEnrollState(): void {
  enrollingDids.clear();
  retryAfter.clear();
}
