/**
 * Reconciling mirror sync — the authoritative mirror ↔ PDS repair.
 *
 * The webhook path (worker/webhook.ts) keeps the mirror live, but it can only
 * apply events TAP actually delivers. When TAP drops events the mirror
 * silently diverges, and the divergence is permanent because nothing on the
 * read side ever removes a stale row:
 *
 *   - missing rows: records created on the PDS that never reached the webhook
 *     (relay doesn't carry the PDS, parse error, account migration). The
 *     enroll-time backfill heals these — it's upsert-only.
 *   - stale rows: records deleted on the PDS whose delete never reached the
 *     webhook. NOTHING heals these today. This is the vicwalker.dev.br case:
 *     migrated PDS → TAP never delivered a single event → mirror frozen at the
 *     enroll-time snapshot, showing bookmarks the user long since deleted.
 *
 * reconcileDid() treats the PDS as the source of truth: upsert every current
 * record, then DELETE every mirror row whose record no longer exists on the
 * PDS.
 *
 * Safety: the read-only PDS pass (fetchLiveRepo) runs FIRST and throws on any
 * collection failure. Deletes run only after it fully succeeds, so a transient
 * PDS error, a slow-loris timeout, or a stale/wrong host can never wipe a
 * user's mirror — the worst case is "no change this run". Callers must pass a
 * PDS host they've confirmed is the DID's current one (resolve via PLC).
 */

import { db } from "./db.ts";
import {
  deleteAnnotation,
  deleteBookmark,
  deletePreferences,
  deleteTag,
} from "../mirror/upserts.ts";
import {
  fetchLiveRepo,
  type LiveUris,
  liveUrisOf,
  upsertLiveRepo,
} from "./mirror-sync.ts";

export interface ReconcileCounts {
  bookmarks: number;
  annotations: number;
  tags: number;
  preferences: number;
}

export interface ReconcileResult {
  did: string;
  dryRun: boolean;
  /** Rows removed from the mirror because they no longer exist on the PDS. */
  deleted: ReconcileCounts;
  /** What the PDS currently holds (post-upsert mirror target). */
  live: ReconcileCounts;
}

/** Delete mirror rows for `did` whose URI isn't in the live set. Returns the
 * count removed (or that WOULD be removed, when dryRun). */
async function deleteMissing(
  table: "bookmarks" | "annotations" | "tags",
  did: string,
  live: Set<string>,
  del: (uri: string, did: string) => Promise<void>,
  dryRun: boolean,
): Promise<number> {
  const res = await db.execute({
    sql: `SELECT uri FROM ${table} WHERE did = ?`,
    args: [did],
  });
  let removed = 0;
  for (const row of res.rows) {
    const uri = String(row[0]);
    if (!live.has(uri)) {
      if (!dryRun) await del(uri, did);
      removed++;
    }
  }
  return removed;
}

/**
 * Reconcile one DID's mirror against its PDS. `pdsUrl` MUST be the DID's
 * current PDS (callers resolve/verify via PLC) — reconciling against a stale
 * host would delete every row as "missing", which the read-first ordering
 * only protects against when the stale host *errors*, not when it answers
 * for a different (e.g. deactivated) repo.
 */
export async function reconcileDid(
  did: string,
  pdsUrl: string,
  opts: { dryRun?: boolean } = {},
): Promise<ReconcileResult> {
  const dryRun = opts.dryRun ?? false;

  // Read-only PDS pass FIRST. A throw here aborts before any delete — this is
  // the property that makes delete-missing safe against transient failures.
  const repo = await fetchLiveRepo(pdsUrl, did);
  const uris: LiveUris = dryRun
    ? liveUrisOf(repo)
    : await upsertLiveRepo(did, repo);

  const deleted: ReconcileCounts = {
    bookmarks: await deleteMissing(
      "bookmarks",
      did,
      uris.bookmarks,
      deleteBookmark,
      dryRun,
    ),
    annotations: await deleteMissing(
      "annotations",
      did,
      uris.annotations,
      deleteAnnotation,
      dryRun,
    ),
    tags: await deleteMissing("tags", did, uris.tags, deleteTag, dryRun),
    preferences: 0,
  };

  // Preferences is one row per DID (no URI). Delete it only when the PDS holds
  // no preferences record AND the mirror currently has one.
  if (!uris.hasPreferences) {
    const pref = await db.execute({
      sql: "SELECT COUNT(*) FROM preferences WHERE did = ?",
      args: [did],
    });
    if (Number(pref.rows[0]?.[0] ?? 0) > 0) {
      if (!dryRun) await deletePreferences(did);
      deleted.preferences = 1;
    }
  }

  return {
    did,
    dryRun,
    deleted,
    live: {
      bookmarks: uris.bookmarks.size,
      annotations: uris.annotations.size,
      tags: uris.tags.size,
      preferences: uris.hasPreferences ? 1 : 0,
    },
  };
}
