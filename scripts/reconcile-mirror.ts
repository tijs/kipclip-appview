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
 * Default (no --all/--did) runs the bookmark-count and TAP forwarding-drift
 * audits first and reconciles only the DIDs that diverge — cheap enough for a
 * daily timer. --all forces a full sweep. The audit re-resolves a migrated PDS
 * via PLC and persists the corrected host, so reconcile always hits the right
 * repo.
 *
 * Exit codes: 0 = clean run, 2 = every target failed (or DB unavailable).
 * A run that repairs rows still exits 0 — repair is the job, not a failure.
 */

import { db } from "../lib/db.ts";
import {
  type ReconcileCounts,
  reconcileDid,
  type ReconcileResult,
} from "../lib/reconcile.ts";
import { auditTrackedDrift } from "../lib/drift-audit.ts";
import { auditForwardingDrift } from "../lib/forwarding-audit.ts";
import { resolveDid } from "../lib/plc-resolver.ts";
import { captureMessage } from "../lib/sentry.ts";

interface Target {
  did: string;
  pdsUrl: string | null;
}

interface TargetResolution {
  targets: Target[];
  /** Tracked DIDs excluded from this run, with their classification. These
   * are the rows that previously collapsed into `checked=0`. */
  skipped: Array<
    { did: string; pdsError: string | null; pdsErrorClass: string | null }
  >;
}

async function mirrorCounts(did: string): Promise<ReconcileCounts> {
  const res = await db.execute({
    sql: `
      SELECT
        (SELECT COUNT(*) FROM bookmarks WHERE did = ?),
        (SELECT COUNT(*) FROM annotations WHERE did = ?),
        (SELECT COUNT(*) FROM tags WHERE did = ?),
        (SELECT COUNT(*) FROM preferences WHERE did = ?)
    `,
    args: [did, did, did, did],
  });
  const [bookmarks = 0, annotations = 0, tags = 0, preferences = 0] =
    res.rows[0] ?? [];
  return {
    bookmarks: Number(bookmarks),
    annotations: Number(annotations),
    tags: Number(tags),
    preferences: Number(preferences),
  };
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

async function resolveTargets(args: string[]): Promise<TargetResolution> {
  const didIdx = args.indexOf("--did");
  if (didIdx >= 0) {
    const did = args[didIdx + 1];
    if (!did) {
      console.error("[reconcile] --did requires a DID argument");
      Deno.exit(2);
    }
    return {
      targets: [{ did, pdsUrl: await storedPdsUrl(did) }],
      skipped: [],
    };
  }

  if (args.includes("--all")) {
    const res = await db.execute({
      sql: "SELECT did, pds_url FROM tracked_dids ORDER BY added_at ASC",
      args: [],
    });
    return {
      targets: res.rows.map((r) => ({
        did: String(r[0]),
        pdsUrl: (r[1] as string | undefined) ?? null,
      })),
      skipped: [],
    };
  }

  // Default: audit first, reconcile only divergent DIDs (either direction).
  const audit = await auditTrackedDrift();
  if (audit.errors.length || audit.skipped.length) {
    console.warn(
      `[reconcile] ${audit.errors.length} DID(s) had PDS errors and ` +
        `${audit.skipped.length} were skipped (cooldown) during audit — ` +
        `excluded from this run:`,
    );
    for (const d of [...audit.errors, ...audit.skipped]) {
      console.warn(
        `  ${d.did}  skipped=${d.skipped} class=${d.pdsErrorClass ?? "?"} ${
          d.pdsError ?? ""
        }`,
      );
    }
  }

  const targets = new Map<string, Target>();
  for (const d of [...audit.recoverable, ...audit.ahead]) {
    targets.set(d.did, { did: d.did, pdsUrl: d.pdsUrl });
  }

  const forwarding = await auditForwardingDrift();
  if (forwarding.skipped) {
    console.warn(
      `[reconcile] forwarding-drift audit skipped (${forwarding.reason})`,
    );
  } else {
    for (const row of forwarding.flagged) {
      if (!targets.has(row.did)) {
        targets.set(row.did, {
          did: row.did,
          pdsUrl: await storedPdsUrl(row.did),
        });
      }
    }
  }

  return {
    targets: [...targets.values()],
    skipped: [...audit.errors, ...audit.skipped].map((d) => ({
      did: d.did,
      pdsError: d.pdsError,
      pdsErrorClass: d.pdsErrorClass,
    })),
  };
}

function countTotal(c: ReconcileCounts): number {
  return c.bookmarks + c.annotations + c.tags + c.preferences;
}

function countsText(c: ReconcileCounts): string {
  return `{b:${c.bookmarks},a:${c.annotations},t:${c.tags},p:${c.preferences}}`;
}

async function main() {
  const args = Deno.args;
  const dryRun = args.includes("--dry-run");

  let resolution: TargetResolution;
  try {
    resolution = await resolveTargets(args);
  } catch (err) {
    console.error(`[reconcile] could not determine targets: ${err}`);
    Deno.exit(2);
  }
  const { targets, skipped } = resolution;

  console.log(
    `[reconcile] ${
      dryRun ? "DRY RUN — " : ""
    }${targets.length} DID(s) to check` +
      (skipped.length > 0
        ? `, ${skipped.length} excluded (PDS errors/cooldown — see below)`
        : ""),
  );

  let changed = 0;
  let failures = 0;
  const repaired: Array<Record<string, unknown>> = [];

  for (const t of targets) {
    const before = await mirrorCounts(t.did);
    try {
      const res = await reconcileWithResolve(t, dryRun);
      const after = dryRun ? before : await mirrorCounts(t.did);
      if (
        countTotal(before) !== countTotal(after) ||
        countTotal(res.deleted) > 0
      ) {
        changed++;
        repaired.push({
          did: t.did,
          before,
          after: res.live,
          deleted: res.deleted,
        });
      }
      console.log(
        `[reconcile] ${t.did} mirror ${countsText(before)}->${
          countsText(
            after,
          )
        } ` +
          `live=${countsText(res.live)} deleted=${countsText(res.deleted)}`,
      );
    } catch (err) {
      failures++;
      console.error(`[reconcile] ${t.did} FAILED: ${err}`);
    }
  }

  console.log(
    `[reconcile] done — checked=${targets.length} changed=${changed} ` +
      `failed=${failures} skipped=${skipped.length}` +
      (skipped.length > 0
        ? " (excluded: " +
          skipped
            .map((s) => `${s.did}#${s.pdsErrorClass ?? "?"}`)
            .join(" ")
        : "") +
      (skipped.length > 0 ? ")" : "") +
      `${dryRun ? " (dry run, no writes)" : ""}`,
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
