/**
 * Background auto-enrollment for new users.
 *
 * Triggered fire-and-forget from /api/initial-data on first request by an
 * untracked DID. Runs the full PDS backfill, then inserts the tracked_dids
 * row with BOTH timestamps set atomically so the user never sees a "syncing"
 * state with 0 bookmarks — the mirror gate opens only after data is ready.
 */

import {
  upsertAnnotation,
  upsertBookmark,
  upsertPreferences,
  upsertTag,
} from "../mirror/upserts.ts";
import { db } from "./db.ts";
import { getMirrorMode } from "./mirror-config.ts";
import { captureMessage } from "./sentry.ts";

const TAP_CONTROL_URL = Deno.env.get("TAP_CONTROL_URL") ??
  "http://127.0.0.1:2480";
// kipclip and TAP share a single secret. kipclip exposes it as
// TAP_WEBHOOK_SECRET (see worker/webhook.ts). Read the same env var for
// outbound /repos/add — reading a separate, never-set TAP_ADMIN_PASSWORD
// silently produced 401s and dropped users from TAP's tracked set.
// Read at call time, not module load, so tests can toggle the value
// without re-importing.
function tapWebhookSecret(): string | undefined {
  return Deno.env.get("TAP_WEBHOOK_SECRET");
}

// Per-fetch timeouts. TAP /repos/add is a single in-process call to a local
// process on the box (low ms in practice). listRecords hits the user's PDS,
// which can be anywhere on the internet — give it a more generous budget but
// still bounded so a slow-loris PDS can't wedge enrollment indefinitely.
const TAP_FETCH_TIMEOUT_MS = 10_000;
const PDS_FETCH_TIMEOUT_MS = 20_000;

// Per-DID cooldown so a sustained TAP/PDS outage doesn't produce one Sentry
// event per page-load per user. After a failure, skip silently for the
// cooldown window — the user's next request beyond the window retries.
const RETRY_COOLDOWN_MS = 30_000;
const lastFailureAt = new Map<string, number>();

// Prevents concurrent enrollment attempts for the same DID within one
// server process lifetime. A second request during the background run is a
// no-op; the DID gets tracked before the next login cycle completes.
const enrollingDids = new Set<string>();

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
}

async function listAll(
  pdsUrl: string,
  did: string,
  collection: string,
): Promise<any[]> {
  const records: any[] = [];
  let cursor: string | undefined;
  while (true) {
    const url = new URL(`${pdsUrl}/xrpc/com.atproto.repo.listRecords`);
    url.searchParams.set("repo", did);
    url.searchParams.set("collection", collection);
    url.searchParams.set("limit", "100");
    if (cursor) url.searchParams.set("cursor", cursor);
    const res = await fetchWithTimeout(
      url.toString(),
      { method: "GET" },
      PDS_FETCH_TIMEOUT_MS,
    );
    if (!res.ok) {
      throw new Error(`listRecords ${collection}: ${res.status}`);
    }
    const data = await res.json();
    const batch: any[] = data.records ?? [];
    records.push(...batch);
    cursor = data.cursor;
    if (!cursor || batch.length === 0) break;
  }
  return records;
}

function str(obj: unknown, key: string): string | undefined {
  if (obj && typeof obj === "object" && key in (obj as object)) {
    const v = (obj as Record<string, unknown>)[key];
    return typeof v === "string" ? v : undefined;
  }
}

function arr(val: unknown): string[] {
  if (!Array.isArray(val)) return [];
  return val.filter((x): x is string => typeof x === "string");
}

// TAP /repos/add is verified idempotent (200 on duplicate). Retrying after
// a successful enroll but failed downstream step is safe.
export async function tapEnroll(did: string): Promise<void> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  const secret = tapWebhookSecret();
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

export async function runBackfill(did: string, pdsUrl: string): Promise<void> {
  const [bookmarks, kipclipAnnotations, legacyAnnotations, tags, prefs] =
    await Promise.all([
      listAll(pdsUrl, did, "community.lexicon.bookmarks.bookmark"),
      listAll(pdsUrl, did, "com.kipclip.annotation"),
      listAll(pdsUrl, did, "app.bookmark.annotation"),
      listAll(pdsUrl, did, "com.kipclip.tag"),
      listAll(pdsUrl, did, "com.kipclip.preferences"),
    ]);

  for (const r of bookmarks) {
    const rkey = r.uri.split("/").pop() ?? "";
    const v = r.value ?? {};
    const enriched = (v["$enriched"] as Record<string, unknown>) ?? {};
    await upsertBookmark({
      uri: r.uri,
      did,
      rkey,
      cid: r.cid,
      subject: str(v, "subject") ?? "",
      createdAt: str(v, "createdAt") ?? "",
      tags: arr(v["tags"]),
      enrichedTitle: str(enriched, "title") ?? str(v, "title") ?? null,
      enrichedDescription: str(enriched, "description") ?? null,
      enrichedFavicon: str(enriched, "favicon") ?? null,
      enrichedImage: str(enriched, "image") ?? null,
    });
  }

  for (const r of [...kipclipAnnotations, ...legacyAnnotations]) {
    const rkey = r.uri.split("/").pop() ?? "";
    const v = r.value ?? {};
    await upsertAnnotation({
      uri: r.uri,
      did,
      rkey,
      cid: r.cid,
      subject: str(v, "subject") ?? "",
      title: str(v, "title") ?? null,
      description: str(v, "description") ?? null,
      favicon: str(v, "favicon") ?? null,
      image: str(v, "image") ?? null,
      note: str(v, "note") ?? null,
    });
  }

  for (const r of tags) {
    const rkey = r.uri.split("/").pop() ?? "";
    const v = r.value ?? {};
    await upsertTag({
      uri: r.uri,
      did,
      rkey,
      cid: r.cid,
      value: str(v, "value") ?? "",
      createdAt: str(v, "createdAt") ?? "",
    });
  }

  for (const r of prefs) {
    const v = r.value ?? {};
    await upsertPreferences({
      did,
      cid: r.cid,
      dateFormat: str(v, "dateFormat") ?? null,
      readingListTag: str(v, "readingListTag") ?? null,
    });
  }
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
  let stage: "tapEnroll" | "backfill" | "trackedDids" = "tapEnroll";
  try {
    console.log(`[auto-enroll] starting for ${did}`);
    await tapEnroll(did);
    stage = "backfill";
    await runBackfill(did, pdsUrl);
    stage = "trackedDids";
    const now = Date.now();
    await db.execute({
      sql: `
        INSERT INTO tracked_dids
          (did, pds_url, added_at, backfill_started_at, backfill_complete_at, last_seq, last_event_at)
        VALUES (?, ?, ?, ?, ?, NULL, NULL)
        ON CONFLICT(did) DO UPDATE SET
          pds_url = COALESCE(tracked_dids.pds_url, excluded.pds_url),
          backfill_started_at = COALESCE(tracked_dids.backfill_started_at, excluded.backfill_started_at),
          backfill_complete_at = COALESCE(tracked_dids.backfill_complete_at, excluded.backfill_complete_at)
      `,
      args: [did, pdsUrl, now, now, now],
    });
    lastFailureAt.delete(did);
    console.log(`[auto-enroll] complete for ${did}`);
  } catch (err) {
    lastFailureAt.set(did, Date.now());
    captureMessage("auto-enroll failed", "error", {
      did,
      stage,
      error: String(err),
    });
    console.error(`[auto-enroll] failed for ${did} at ${stage}:`, err);
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
    .catch(() => {/* already captured in runEnrollment */})
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
  const lastFail = lastFailureAt.get(did);
  if (lastFail && Date.now() - lastFail < RETRY_COOLDOWN_MS) return;
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
  lastFailureAt.clear();
}
