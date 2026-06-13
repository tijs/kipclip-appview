/**
 * Reconciling mirror sync — repair tables that diverged from the PDS.
 *
 * Treats each tracked DID's PDS as the source of truth: upserts every current
 * record AND deletes mirror rows for records no longer on the PDS. Fixes both
 * drift directions the webhook path can't (missing creates AND stale deletes),
 * whatever the cause — TAP event drops, `invalid repoOp` parse errors, account
 * migration, or a PDS the relay doesn't carry.
 *
 * Doubles as a systemd `Type=oneshot` daily timer and an operator CLI.
 *
 * Usage (run on the box where DATABASE_URL points at the primary db):
 *
 *   deno run --allow-net --allow-env --allow-read --allow-write --allow-sys \
 *     --allow-ffi scripts/reconcile-mirror.ts            # drifted DIDs only
 *   ... scripts/reconcile-mirror.ts --all                # every tracked DID
 *   ... scripts/reconcile-mirror.ts --did did:plc:xxxx   # one DID
 *   ... scripts/reconcile-mirror.ts --dry-run            # report, don't write
 *
 * Default (no --all/--did) runs the bookmark-count drift audit first and
 * reconciles only the DIDs that diverge — cheap enough for a daily timer.
 * --all forces a full sweep (catches tag/annotation-only drift the audit's
 * bookmark count misses). The audit re-resolves a migrated PDS via PLC and
 * persists the corrected host, so reconcile always hits the right repo.
 *
 * Exit codes: 0 = clean run, 2 = every target failed (or DB unavailable).
 * A run that repairs rows still exits 0 — repair is the job, not a failure.
 */

import { db } from "../lib/db.ts";
import { reconcileDid, type ReconcileResult } from "../lib/reconcile.ts";
import { auditTrackedDrift } from "../lib/drift-audit.ts";
import { resolveDid } from "../lib/plc-resolver.ts";
import { captureMessage } from "../lib/sentry.ts";

interface Target {
  did: string;
  pdsUrl: string | null;
}

async function mirrorBookmarkCount(did: string): Promise<number> {
  const res = await db.execute({
    sql: "SELECT COUNT(*) FROM bookmarks WHERE did = ?",
    args: [did],
  });
  return Number(res.rows[0]?.[0] ?? 0);
}

async function storedPdsUrl(did: string): Promise<string | null> {
  const res = await db.execute({
    sql: "SELECT pds_url FROM tracked_dids WHERE did = ?",
    args: [did],
  });
  return (res.rows[0]?.[0] as string | undefined) ?? null;
}

/**
 * Reconcile one DID, resolving its current PDS via PLC if the stored host is
 * missing or errors. On a detected migration the corrected host is persisted
 * to tracked_dids so subsequent runs (and the enroll backfill) hit it directly.
 */
async function reconcileWithResolve(
  t: Target,
  dryRun: boolean,
): Promise<ReconcileResult> {
  try {
    if (!t.pdsUrl) throw new Error("no stored pds_url");
    return await reconcileDid(t.did, t.pdsUrl, { dryRun });
  } catch (firstErr) {
    const resolved = await resolveDid(t.did);
    if (!resolved) throw firstErr;
    if (!dryRun && resolved.pdsUrl !== t.pdsUrl) {
      await db.execute({
        sql: "UPDATE tracked_dids SET pds_url = ? WHERE did = ?",
        args: [resolved.pdsUrl, t.did],
      });
    }
    return await reconcileDid(t.did, resolved.pdsUrl, { dryRun });
  }
}

async function resolveTargets(
  args: string[],
): Promise<Target[]> {
  const didIdx = args.indexOf("--did");
  if (didIdx >= 0) {
    const did = args[didIdx + 1];
    if (!did) {
      console.error("[reconcile] --did requires a DID argument");
      Deno.exit(2);
    }
    return [{ did, pdsUrl: await storedPdsUrl(did) }];
  }

  if (args.includes("--all")) {
    const res = await db.execute({
      sql: "SELECT did, pds_url FROM tracked_dids ORDER BY added_at ASC",
      args: [],
    });
    return res.rows.map((r) => ({
      did: String(r[0]),
      pdsUrl: (r[1] as string | undefined) ?? null,
    }));
  }

  // Default: audit first, reconcile only divergent DIDs (either direction).
  const audit = await auditTrackedDrift();
  if (audit.errors.length) {
    console.warn(
      `[reconcile] ${audit.errors.length} DID(s) had PDS errors during audit ` +
        `— skipping this run, will retry next time`,
    );
  }
  return [...audit.recoverable, ...audit.ahead].map((d) => ({
    did: d.did,
    pdsUrl: d.pdsUrl,
  }));
}

function delTotal(r: ReconcileResult): number {
  const d = r.deleted;
  return d.bookmarks + d.annotations + d.tags + d.preferences;
}

async function main() {
  const args = Deno.args;
  const dryRun = args.includes("--dry-run");

  let targets: Target[];
  try {
    targets = await resolveTargets(args);
  } catch (err) {
    console.error(`[reconcile] could not determine targets: ${err}`);
    Deno.exit(2);
  }

  console.log(
    `[reconcile] ${
      dryRun ? "DRY RUN — " : ""
    }${targets.length} DID(s) to check`,
  );

  let changed = 0;
  let failures = 0;
  const repaired: Array<Record<string, unknown>> = [];

  for (const t of targets) {
    const before = await mirrorBookmarkCount(t.did);
    try {
      const res = await reconcileWithResolve(t, dryRun);
      const after = dryRun ? before : await mirrorBookmarkCount(t.did);
      const removed = delTotal(res);
      if (removed > 0 || before !== after) {
        changed++;
        repaired.push({
          did: t.did,
          bookmarks: `${before}->${res.live.bookmarks}`,
          deleted: res.deleted,
        });
      }
      console.log(
        `[reconcile] ${t.did} bookmarks ${before}->${after} ` +
          `live=${res.live.bookmarks} deleted=` +
          `{b:${res.deleted.bookmarks},a:${res.deleted.annotations},` +
          `t:${res.deleted.tags},p:${res.deleted.preferences}}`,
      );
    } catch (err) {
      failures++;
      console.error(`[reconcile] ${t.did} FAILED: ${err}`);
    }
  }

  console.log(
    `[reconcile] done — checked=${targets.length} changed=${changed} ` +
      `failed=${failures}${dryRun ? " (dry run, no writes)" : ""}`,
  );

  // Surface a repair summary to Sentry when we actually changed data, so the
  // operator has a record of what the timer fixed (and can spot a runaway).
  if (!dryRun && changed > 0) {
    captureMessage("mirror reconcile repaired drift", "info", {
      changed,
      failed: failures,
      sample: repaired.slice(0, 20),
    });
  }

  // Hard failure only when every target failed (e.g. DB/network down) — a
  // partial failure with some successes is a normal transient and stays exit 0
  // so the timer doesn't flap.
  if (targets.length > 0 && failures === targets.length) Deno.exit(2);
  Deno.exit(0);
}

await main();
