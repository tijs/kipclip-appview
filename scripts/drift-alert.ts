/**
 * Periodic mirror-drift alert.
 *
 * Runs the same audit as `scripts/audit-mirror.ts` and emits a Sentry
 * warning when any tracked DID has more bookmarks on its PDS than in
 * the local mirror (recoverable drift — the silent-401 bug pattern).
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
import { captureMessage, Sentry } from "../lib/sentry.ts";

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

async function main() {
  const quiet = Deno.args.includes("--quiet");

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

  console.log(
    `[drift-alert] tracked=${rows.length} recoverable=${recoverable.length} ` +
      `ahead=${ahead.length} errors=${errors.length}`,
  );

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
    await Sentry.flush(2000).catch(() => {});
    Deno.exit(1);
  }

  await Sentry.flush(2000).catch(() => {});
  Deno.exit(0);
}

await main();
