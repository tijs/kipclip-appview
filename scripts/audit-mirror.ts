/**
 * Audit mirror-vs-PDS divergence across every tracked DID.
 *
 * Thin CLI wrapper over `lib/drift-audit.ts`. Prints a table sorted by
 * absolute diff; rows where PDS > mirror are tagged `RECOVER` (the
 * silent-401 bug pattern). Use `scripts/recover-mirror.ts` to backfill
 * a specific DID.
 *
 * Usage (run on the box where DATABASE_URL points at the primary db):
 *
 *   deno run --allow-net --allow-env --allow-read --allow-write \
 *     scripts/audit-mirror.ts
 *
 *   deno run -A scripts/audit-mirror.ts --json  # machine-readable
 */

import { auditTrackedDrift, type DriftRow } from "../lib/drift-audit.ts";

async function main() {
  const jsonOut = Deno.args.includes("--json");

  const { rows } = await auditTrackedDrift((row) => {
    if (jsonOut) return;
    const tag = row.pdsError
      ? `ERROR ${row.pdsError}`
      : `mirror=${row.mirror} pds=${row.pds} diff=${
        (row.pds ?? 0) - row.mirror
      }`;
    console.error(`[audit] ${row.did} ${tag}`);
  });

  if (jsonOut) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }

  const sorted: DriftRow[] = [...rows].sort((a, b) => {
    const da = (a.pds ?? 0) - a.mirror;
    const dbb = (b.pds ?? 0) - b.mirror;
    return dbb - da;
  });

  console.log("");
  console.log(
    "did                                          mirror   pds  diff  status",
  );
  console.log(
    "-------------------------------------------- ------ ----- ----- ------",
  );
  let divergent = 0;
  let recoverable = 0;
  for (const r of sorted) {
    const diff = (r.pds ?? 0) - r.mirror;
    let status = "ok";
    if (r.pdsError) status = `error: ${r.pdsError.slice(0, 30)}`;
    else if (diff > 0) {
      status = "RECOVER";
      recoverable++;
      divergent++;
    } else if (diff < 0) {
      status = "ahead";
      divergent++;
    }
    console.log(
      `${r.did.padEnd(44)} ${String(r.mirror).padStart(6)} ${
        String(r.pds ?? "-").padStart(5)
      } ${String(diff).padStart(5)}  ${status}`,
    );
  }

  console.log("");
  console.log(
    `tracked=${sorted.length} divergent=${divergent} recoverable=${recoverable}`,
  );
}

await main();
