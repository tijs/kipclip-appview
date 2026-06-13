/**
 * Forwarding-drift audit — detect repos where TAP has synced records the
 * kipclip mirror never received.
 *
 * TAP keeps its own copy of every tracked repo (`repo_records`, filtered to our
 * tracked collections) and forwards each event to `/api/sync/hook`. When that
 * forwarding hop silently fails for a repo — the vicwalker.dev.br migration
 * case, where TAP held the current repo at the right rev but forwarded zero
 * events — TAP's record count and the mirror's diverge while `last_event_at`
 * goes stale and everything else looks healthy.
 *
 * This compares, per tracked DID, the mirror's tracked-collection record count
 * against TAP's, using only the two local SQLite files (no PDS/relay calls). A
 * mismatch with an EMPTY TAP outbox (nothing pending) means TAP believes it has
 * forwarded everything yet the mirror disagrees — a stuck forwarding gap, which
 * is exactly what would have flagged vicwalker on day one.
 *
 * Runs inside drift-alert (05:00 UTC) — BEFORE the daily reconcile (05:30) that
 * would otherwise heal the divergence and hide it. Best-effort: if tap.db is
 * unreadable (local dev with no TAP, permissions, etc.) the audit returns
 * `skipped` rather than throwing, so it can never break drift-alert.
 *
 * tap.db is opened read-only in intent (SELECT-only); @libsql rejects a
 * `?mode=ro` URL param, so we open the plain `file:` URL and never issue a
 * write. Verified the kipclip user can read TAP's live WAL db this way.
 */

import { db } from "./db.ts";

// Collections TAP forwards to us (mirrors worker/webhook.ts). Both annotation
// collections land in the single `annotations` mirror table, so both count
// toward the same total on each side.
const TRACKED_COLLECTIONS = [
  "community.lexicon.bookmarks.bookmark",
  "com.kipclip.annotation",
  "app.bookmark.annotation",
  "com.kipclip.tag",
  "com.kipclip.preferences",
];

const DEFAULT_TAP_DB_PATH = "/var/lib/tap/tap.db";

export interface ForwardingDriftRow {
  did: string;
  /** Tracked-collection records in the kipclip mirror. */
  mirror: number;
  /** Tracked-collection records in TAP's repo_records. */
  tap: number;
  /** TAP outbox entries pending for this DID (forwarding in flight). */
  outbox: number;
}

export interface ForwardingAuditResult {
  /** True when tap.db couldn't be read; `reason` explains why. */
  skipped: boolean;
  reason?: string;
  /** DIDs where mirror and TAP disagree with nothing pending in the outbox. */
  flagged: ForwardingDriftRow[];
  /** Number of tracked DIDs compared. */
  checked: number;
}

/**
 * A DID is flagged when the mirror and TAP counts differ by at least `minDiff`
 * AND TAP's outbox for that DID is empty. The empty-outbox guard rules out a
 * transient mid-flight forward; an empty outbox means TAP considers itself
 * caught up, so a remaining mismatch is a genuine dropped forward.
 */
export function flagForwardingDrift(
  rows: ForwardingDriftRow[],
  minDiff = 1,
): ForwardingDriftRow[] {
  return rows.filter(
    (r) => r.outbox === 0 && Math.abs(r.mirror - r.tap) >= minDiff,
  );
}

export async function auditForwardingDrift(
  opts: { tapDbPath?: string; minDiff?: number } = {},
): Promise<ForwardingAuditResult> {
  const minDiff = opts.minDiff ?? 1;

  // Mirror tracked-collection totals per DID from the primary kipclip db.
  const mirrorRes = await db.execute({
    sql: `
      SELECT d.did,
        (SELECT COUNT(*) FROM bookmarks WHERE did = d.did)
       +(SELECT COUNT(*) FROM annotations WHERE did = d.did)
       +(SELECT COUNT(*) FROM tags WHERE did = d.did)
       +(SELECT COUNT(*) FROM preferences WHERE did = d.did) AS mirror
      FROM tracked_dids d
    `,
    args: [],
  });
  const mirrorByDid = new Map<string, number>();
  for (const row of mirrorRes.rows) {
    mirrorByDid.set(String(row[0]), Number(row[1] ?? 0));
  }
  // Nothing tracked → nothing to compare; skip tap.db entirely.
  if (mirrorByDid.size === 0) {
    return { skipped: false, flagged: [], checked: 0 };
  }

  // Treat an empty TAP_DB_PATH as unset (?? keeps "" — which would open an
  // empty `file:` db with no repo_records and skip every run).
  const envPath = Deno.env.get("TAP_DB_PATH");
  const path = opts.tapDbPath ??
    (envPath && envPath.length > 0 ? envPath : DEFAULT_TAP_DB_PATH);
  // deno-lint-ignore no-explicit-any
  let tapClient: any;
  try {
    const { createClient } = await import("@libsql/client");
    tapClient = createClient({ url: `file:${path}` });

    const placeholders = TRACKED_COLLECTIONS.map(() => "?").join(",");
    const tapRes = await tapClient.execute({
      sql:
        `SELECT did, COUNT(*) FROM repo_records WHERE collection IN (${placeholders}) GROUP BY did`,
      args: TRACKED_COLLECTIONS,
    });
    const tapByDid = new Map<string, number>();
    for (const row of tapRes.rows) {
      tapByDid.set(String(row[0]), Number(row[1] ?? 0));
    }

    const outboxRes = await tapClient.execute({
      sql: "SELECT did, COUNT(*) FROM outbox_buffers GROUP BY did",
      args: [],
    });
    const outboxByDid = new Map<string, number>();
    for (const row of outboxRes.rows) {
      outboxByDid.set(String(row[0]), Number(row[1] ?? 0));
    }

    const rows: ForwardingDriftRow[] = [];
    for (const [did, mirror] of mirrorByDid) {
      rows.push({
        did,
        mirror,
        tap: tapByDid.get(did) ?? 0,
        outbox: outboxByDid.get(did) ?? 0,
      });
    }
    return {
      skipped: false,
      flagged: flagForwardingDrift(rows, minDiff),
      checked: rows.length,
    };
  } catch (err) {
    return { skipped: true, reason: String(err), flagged: [], checked: 0 };
  } finally {
    try {
      tapClient?.close();
    } catch { /* best-effort */ }
  }
}
