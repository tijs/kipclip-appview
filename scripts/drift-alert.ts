/**
 * Periodic mirror-drift alert.
 *
 * Runs the same audit as `scripts/audit-mirror.ts` and emits a Sentry
 * warning when any tracked DID has more bookmarks on its PDS than in
 * the local mirror (recoverable drift — the silent-401 bug pattern).
 * Also compares kipclip's tracked_dids count against TAP's repo-count
 * to detect enrollment drift (DIDs tracked locally but missing from TAP).
 *
 * Designed as a systemd `Type=oneshot` daily timer. Output goes to
 * journald via stdout/stderr; Sentry capture is optional (skipped when
 * `SENTRY_DSN` is unset). Exit codes:
 *
 *   0  no drift
 *   1  drift detected (recoverable rows present)
 *   2  audit failed entirely (e.g. DB unavailable)
 *
 * Exit 1 lets operators chain the alert with `OnFailure=` or a watchdog
 * without needing to parse output.
 *
 * Usage (run on the box):
 *
 *   deno run -A scripts/drift-alert.ts
 *   deno run -A scripts/drift-alert.ts --quiet  # suppress per-DID stderr
 */

import { auditTrackedDrift, type DriftRow } from "../lib/drift-audit.ts";
import { tapEnroll } from "../lib/auto-enroll.ts";
import {
  auditForwardingDrift,
  auditTapEnrollments,
} from "../lib/forwarding-audit.ts";
import { captureMessage, Sentry } from "../lib/sentry.ts";
import { db } from "../lib/db.ts";
import {
  listMissingRepos,
  listMissingReposForRemoval,
  MISSING_REPO_REMOVAL_THRESHOLD_MS,
} from "../lib/missing-repo.ts";

const RECOVERABLE_SAMPLE_CAP = 20;

function summarize(rows: DriftRow[]): Array<Record<string, unknown>> {
  return rows.slice(0, RECOVERABLE_SAMPLE_CAP).map((r) => ({
    did: r.did,
    pdsUrl: r.pdsUrl,
    mirror: r.mirror,
    pds: r.pds,
    diff: (r.pds ?? 0) - r.mirror,
  }));
}

const DEFAULT_TAP_DB_PATH = "/var/lib/tap/tap.db";

async function removeFromTapRepos(dids: string[]): Promise<boolean> {
  if (dids.length === 0) return true;
  const envPath = Deno.env.get("TAP_DB_PATH");
  const path = envPath && envPath.length > 0 ? envPath : DEFAULT_TAP_DB_PATH;
  // deno-lint-ignore no-explicit-any
  let tapClient: any;
  try {
    const { createClient } = await import("@libsql/client");
    tapClient = createClient({ url: `file:${path}` });
    const placeholders = dids.map(() => "?").join(",");
    await tapClient.execute({
      sql: `DELETE FROM repos WHERE did IN (${placeholders})`,
      args: dids,
    });
    return true;
  } catch (err) {
    console.error(`[drift-alert] failed to remove DIDs from TAP repos: ${err}`);
    return false;
  } finally {
    try {
      tapClient?.close();
    } catch {
      /* best-effort */
    }
  }
}

async function cleanupStaleMissingRepos(): Promise<number> {
  const toRemove = await listMissingReposForRemoval(
    MISSING_REPO_REMOVAL_THRESHOLD_MS,
  );
  if (toRemove.length === 0) return 0;

  const dids = toRemove.map((r) => r.did);
  const removedFromTap = await removeFromTapRepos(dids);
  if (!removedFromTap) {
    console.error(
      `[drift-alert] TAP cleanup failed; leaving ${dids.length} stale missing repos for retry`,
    );
    return 0;
  }
  await db.execute({
    sql: `DELETE FROM tracked_dids WHERE did IN (${
      dids
        .map(() => "?")
        .join(",")
    })`,
    args: dids,
  });
  await db.execute({
    sql: `DELETE FROM missing_repos WHERE did IN (${
      dids
        .map(() => "?")
        .join(",")
    })`,
    args: dids,
  });

  for (const did of dids) {
    console.log(`[drift-alert] removed stale missing repo: ${did}`);
  }
  return dids.length;
}

async function main() {
  const quiet = Deno.args.includes("--quiet");

  const missingBefore = await listMissingRepos();
  const missingBeforeSet = new Set(missingBefore.map((r) => r.did));

  let result;
  try {
    result = await auditTrackedDrift((row, i, total) => {
      if (quiet) return;
      const tag = row.pdsError
        ? `ERROR ${row.pdsError}`
        : `mirror=${row.mirror} pds=${row.pds} diff=${
          (row.pds ?? 0) - row.mirror
        }`;
      console.error(`[drift-alert ${i}/${total}] ${row.did} ${tag}`);
    });
  } catch (err) {
    console.error(`[drift-alert] audit failed: ${err}`);
    captureMessage("drift-alert audit failed", "error", { error: String(err) });
    await Sentry.flush(2000).catch(() => {});
    Deno.exit(2);
  }

  const { rows, recoverable, ahead, errors } = result;
  const migrated = rows.filter((r) => r.pdsMigrated);
  let driftDetected = false;

  console.log(
    `[drift-alert] tracked=${rows.length} recoverable=${recoverable.length} ` +
      `ahead=${ahead.length} errors=${errors.length} migrated=${migrated.length}`,
  );

  if (migrated.length > 0) {
    console.log(
      `[drift-alert] PDS migrations detected (tracked_dids updated):`,
    );
    for (const r of migrated) {
      console.log(`  ${r.did}  ${r.pdsMigrated!.from} -> ${r.pdsMigrated!.to}`);
    }
  }

  const removed = await cleanupStaleMissingRepos();
  const missingAfter = await listMissingRepos();
  const newlyConfirmed = missingAfter.filter(
    (r) => !missingBeforeSet.has(r.did),
  ).length;
  console.log(
    `[drift-alert] missing_repos=${missingAfter.length} ` +
      `(checked ${missingBefore.length}, newly confirmed ${newlyConfirmed}, stale removals ${removed})`,
  );

  const enrollment = await auditTapEnrollments();
  if (!enrollment.skipped) {
    const missingSet = new Set(missingAfter.map((r) => r.did));
    // Re-enrolling a known-missing DID just re-adds it to TAP's retry loop.
    // Treat those as accounted-for until the cleanup threshold removes them.
    const kipclipOnlyActionable = enrollment.kipclipOnly.filter(
      (did) => !missingSet.has(did),
    );
    const enrollmentDrift = kipclipOnlyActionable.length > 0 ||
      enrollment.tapOnly.length > 0;
    console.log(
      `[drift-alert] TAP repo-count=${enrollment.tapCount} kipclip tracked=${enrollment.kipclipCount}` +
        (enrollmentDrift ? " MISMATCH" : " ok"),
    );
    if (enrollmentDrift) {
      console.log(
        `[drift-alert] enrollment drift kipclip-only=${kipclipOnlyActionable.length} ` +
          `tap-only=${enrollment.tapOnly.length}`,
      );
      for (const did of kipclipOnlyActionable) {
        console.log(`  kipclip-only ${did}`);
      }
      for (const did of enrollment.tapOnly) {
        console.log(`  tap-only ${did}`);
      }

      // A local-only DID was fully enrolled before, so TAP's idempotent add is
      // sufficient to restore live sync. The opposite direction needs a PDS
      // backfill before a tracked_dids row can safely be created, so leave it
      // for operator recovery instead of creating an empty mirror cohort.
      const reenrollment = await Promise.allSettled(
        kipclipOnlyActionable.map((did) => tapEnroll(did)),
      );
      const reenrollFailures = reenrollment.flatMap((result, index) =>
        result.status === "rejected"
          ? [
            {
              did: kipclipOnlyActionable[index],
              error: String(result.reason),
            },
          ]
          : []
      );
      if (reenrollment.length > 0) {
        console.log(
          `[drift-alert] TAP re-enrollment restored=${
            reenrollment.length - reenrollFailures.length
          } failed=${reenrollFailures.length}`,
        );
      }
      captureMessage(
        `TAP/kipclip tracked-DID mismatch: TAP=${enrollment.tapCount} kipclip=${enrollment.kipclipCount}`,
        "warning",
        {
          tapCount: enrollment.tapCount,
          kipclipCount: enrollment.kipclipCount,
          kipclipOnly: kipclipOnlyActionable,
          tapOnly: enrollment.tapOnly,
          reenrollFailures,
          knownMissing: missingAfter.length,
        },
      );
      driftDetected = true;
    }
  } else {
    console.log(
      `[drift-alert] TAP enrollment check skipped (${enrollment.reason})`,
    );
  }

  // Forwarding-drift: TAP synced records the mirror never received (local
  // mirror vs TAP repo_records). Runs before the 05:30 reconcile, which would
  // otherwise heal and hide the divergence. This is the signal that would have
  // caught vicwalker.dev.br on day one instead of via a user bug report.
  const forwarding = await auditForwardingDrift();
  if (forwarding.skipped) {
    console.log(
      `[drift-alert] forwarding-drift check skipped (${forwarding.reason})`,
    );
  } else {
    console.log(
      `[drift-alert] forwarding-drift checked=${forwarding.checked} ` +
        `flagged=${forwarding.flagged.length}`,
    );
    if (forwarding.flagged.length > 0) {
      const sample = forwarding.flagged
        .slice(0, RECOVERABLE_SAMPLE_CAP)
        .map((r) => ({
          did: r.did,
          mirror: r.mirror,
          tap: r.tap,
          diff: r.mirror - r.tap,
        }));
      for (const s of sample) {
        console.log(
          `  ${s.did}  mirror=${s.mirror} tap=${s.tap} diff=${s.diff}`,
        );
      }
      captureMessage(
        `TAP forwarding drift: ${forwarding.flagged.length} DIDs where mirror != TAP repo_records`,
        "warning",
        {
          flagged: forwarding.flagged.length,
          checked: forwarding.checked,
          sample,
        },
      );
      driftDetected = true;
    }
  }

  if (recoverable.length > 0) {
    const sample = summarize(recoverable);
    console.log(
      `[drift-alert] RECOVER candidates (sample of ${sample.length}):`,
    );
    for (const s of sample) {
      console.log(`  ${s.did}  mirror=${s.mirror} pds=${s.pds} diff=${s.diff}`);
    }
    captureMessage(
      `mirror drift: ${recoverable.length} DIDs have PDS > mirror`,
      "warning",
      {
        tracked: rows.length,
        recoverable: recoverable.length,
        ahead: ahead.length,
        errors: errors.length,
        sample,
      },
    );
    driftDetected = true;
  }

  await Sentry.flush(2000).catch(() => {});
  Deno.exit(driftDetected ? 1 : 0);
}

await main();
