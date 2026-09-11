/**
 * Periodic mirror-drift alert.
 *
 * Runs the same audit as `scripts/audit-mirror.ts` and emits a Sentry
 * warning when any tracked DID has more bookmarks on its PDS than in
 * the local mirror (recoverable drift — the silent-401 bug pattern).
 * Also compares kipclip's tracked_dids count against TAP's repo-count
 * to detect enrollment drift (DIDs tracked locally but missing from TAP).
 *
 * Since v0.24.38 this also:
 *   - classifies every PDS failure (RepoNotFound vs DNS/refused/timeout/5xx)
 *     and persists it to tap_repo_state ('missing' quarantine candidates vs
 *     'unavailable' with a cooldown + recheck schedule);
 *   - QUARANTINES confirmed-missing repos by removing only their TAP
 *     enrollment — tracked_dids, mirror rows, and missing_repos retention
 *     evidence are never touched, and unavailable-PDS rows are never
 *     quarantined. There is no automatic deletion of tracked users here.
 *   - reports cooldown-skips in a separate `skipped` bucket so a run with
 *     known errors is never presented as `checked=0` clean.
 *
 * Designed as a systemd `Type=oneshot` daily timer. Output goes to
 * journald via stdout/stderr; Sentry capture is optional (skipped when
 * `SENTRY_DSN` is unset). Exit codes:
 *
 *   0  no drift, no PDS errors
 *   1  drift detected (recoverable rows present)
 *   2  audit failed entirely (e.g. DB unavailable)
 *   3  PDS errors present (classified; nothing repaired automatically)
 *
 * Exit 1 lets operators chain the alert with `OnFailure=` or a watchdog
 * without needing to parse output. IMPORTANT: since v0.24.38 the systemd
 * unit only marks exit 0 successful — exit 1 (drift) and exit 3 (PDS
 * errors) must be REPORTED as non-clean, not swallowed by
 * `SuccessExitStatus=1`.
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
import { listMissingRepos } from "../lib/missing-repo.ts";
import {
  listQuarantineCandidates,
  listTapRepoStates,
} from "../lib/tap-repo-state.ts";
import { withTapDb } from "../lib/tap-db.ts";

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

function summarizeSkipped(rows: DriftRow[]): Array<Record<string, unknown>> {
  return rows.slice(0, RECOVERABLE_SAMPLE_CAP).map((r) => ({
    did: r.did,
    class: r.pdsErrorClass,
    reason: r.pdsError,
  }));
}

function placeholders(n: number): string {
  return Array.from({ length: n }, () => "?").join(",");
}

async function removeFromTapRepos(dids: string[]): Promise<boolean> {
  if (dids.length === 0) return true;
  try {
    await withTapDb(undefined, async (tapClient) => {
      await tapClient.execute({
        sql: `DELETE FROM repos WHERE did IN (${placeholders(dids.length)})`,
        args: dids,
      });
    });
    return true;
  } catch (err) {
    console.error(`[drift-alert] failed to remove DIDs from TAP repos: ${err}`);
    return false;
  }
}

/**
 * Quarantine confirmed-missing repos: remove ONLY their TAP enrollment so
 * they stop occupying TAP resync workers. Explicitly does NOT delete
 * tracked_dids, mirror rows, or missing_repos retention evidence, and
 * never touches unavailable-PDS rows. TAP-only repos (no tracked_dids row)
 * are excluded here by listQuarantineCandidates — cleaning those up is an
 * approval-gated operator action (scripts/tap-only-cleanup.ts).
 */
async function quarantineMissingRepos(): Promise<number> {
  const candidates = await listQuarantineCandidates();
  if (candidates.length === 0) return 0;

  const dids = candidates.map((r) => r.did);
  const removedFromTap = await removeFromTapRepos(dids);
  if (!removedFromTap) {
    console.error(
      `[drift-alert] TAP quarantine failed; leaving ${dids.length} confirmed-missing repos for retry`,
    );
    return 0;
  }
  // Quarantine is complete: the DID is out of TAP but stays tracked
  // locally with its mirror data and missing-repo evidence intact.
  for (const c of candidates) {
    console.log(
      `[drift-alert] quarantined (TAP enrollment removed, local state kept): ${c.did} (first seen ${
        new Date(c.firstSeenAt).toISOString()
      }, ${c.failureCount} confirmations)`,
    );
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
        ? `${row.skipped ? "SKIP" : "ERROR"} [${
          row.pdsErrorClass ?? "?"
        }] ${row.pdsError}`
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

  const { rows, recoverable, ahead, errors, skipped } = result;
  const migrated = rows.filter((r) => r.pdsMigrated);
  let driftDetected = false;

  console.log(
    `[drift-alert] tracked=${rows.length} recoverable=${recoverable.length} ` +
      `ahead=${ahead.length} errors=${errors.length} skipped=${skipped.length} ` +
      `migrated=${migrated.length}`,
  );

  // Explicit per-class error breakdown — errors must never hide behind
  // checked=0. Bounded: class + did suffix only.
  if (errors.length > 0) {
    const byClass = new Map<string, number>();
    for (const r of errors) {
      const cls = r.pdsErrorClass ?? "unknown";
      byClass.set(cls, (byClass.get(cls) ?? 0) + 1);
    }
    console.log(
      "[drift-alert] PDS errors by class: " +
        [...byClass.entries()].map(([c, n]) => `${c}=${n}`).join(" "),
    );
    for (const r of errors.slice(0, RECOVERABLE_SAMPLE_CAP)) {
      console.error(
        `[drift-alert] error ${r.did} class=${
          r.pdsErrorClass ?? "?"
        } ${r.pdsError}`,
      );
    }
  }
  if (skipped.length > 0) {
    console.log(
      `[drift-alert] skipped (cooldown, not probed): ${
        skipped.map((r) => `${r.did}#${r.pdsErrorClass}`).join(" ")
      }`,
    );
  }

  if (migrated.length > 0) {
    console.log(
      `[drift-alert] PDS migrations detected (tracked_dids updated):`,
    );
    for (const r of migrated) {
      console.log(`  ${r.did}  ${r.pdsMigrated!.from} -> ${r.pdsMigrated!.to}`);
    }
  }

  const quarantined = await quarantineMissingRepos();
  const missingAfter = await listMissingRepos();
  const newlyConfirmed = missingAfter.filter(
    (r) => !missingBeforeSet.has(r.did),
  ).length;
  console.log(
    `[drift-alert] missing_repos=${missingAfter.length} ` +
      `(checked ${missingBefore.length}, newly confirmed ${newlyConfirmed}, quarantined ${quarantined})`,
  );

  const states = await listTapRepoStates();
  const unavailableCount =
    states.filter((s) => s.state === "unavailable").length;
  if (unavailableCount > 0) {
    console.log(
      `[drift-alert] unavailable-PDS cooldowns active=${unavailableCount} (recheck scheduled; none deleted)`,
    );
  }

  const enrollment = await auditTapEnrollments();
  if (!enrollment.skipped) {
    const missingSet = new Set(missingAfter.map((r) => r.did));
    // Re-enrolling a known-missing DID just re-adds it to TAP's retry loop
    // (and undoes quarantine). Treat those as accounted-for.
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
      // sufficient to restore live sync. The opposite direction (tap-only)
      // needs operator approval (scripts/tap-only-cleanup.ts) and a PDS
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
        skippedSamples: summarizeSkipped(skipped),
        sample,
      },
    );
    driftDetected = true;
  }

  await Sentry.flush(2000).catch(() => {});
  // exit 3 = classified PDS errors present (non-clean, nothing repaired
  // automatically). Reported separately from drift so operators can
  // distinguish "mirror behind" (1) from "PDS unreachable/absent" (3).
  if (errors.length > 0) Deno.exit(3);
  Deno.exit(driftDetected ? 1 : 0);
}

await main();
