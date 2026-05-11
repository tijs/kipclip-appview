/**
 * Audit mirror-vs-PDS divergence across every tracked DID.
 *
 * For each row in `tracked_dids`, counts:
 *   - local mirror bookmarks
 *   - PDS community.lexicon.bookmarks.bookmark records (paginated)
 *
 * Prints a table sorted by absolute diff. Recovery candidates have
 * PDS > mirror (the silent-401 bug pattern: PDS holds records the
 * mirror never received because TAP wasn't actually tracking the DID).
 *
 * Usage (run on the box where DATABASE_URL points at the primary db):
 *
 *   deno run --allow-net --allow-env --allow-read --allow-write \
 *     scripts/audit-mirror.ts
 *
 *   deno run -A scripts/audit-mirror.ts --json  # machine-readable
 */

import { db } from "../lib/db.ts";

interface Row {
  did: string;
  pdsUrl: string | null;
  mirror: number;
  pds: number | null;
  pdsError: string | null;
}

async function countPdsBookmarks(
  pdsUrl: string,
  did: string,
): Promise<number> {
  let total = 0;
  let cursor: string | undefined;
  for (let page = 0; page < 200; page++) {
    const url = new URL(`${pdsUrl}/xrpc/com.atproto.repo.listRecords`);
    url.searchParams.set("repo", did);
    url.searchParams.set("collection", "community.lexicon.bookmarks.bookmark");
    url.searchParams.set("limit", "100");
    if (cursor) url.searchParams.set("cursor", cursor);
    const res = await fetch(url.toString(), {
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`listRecords: ${res.status}`);
    const data = await res.json();
    const batch: unknown[] = data.records ?? [];
    total += batch.length;
    cursor = data.cursor;
    if (!cursor || batch.length === 0) break;
  }
  return total;
}

async function main() {
  const jsonOut = Deno.args.includes("--json");

  const tracked = await db.execute({
    sql: "SELECT did, pds_url FROM tracked_dids ORDER BY added_at ASC",
    args: [],
  });

  const rows: Row[] = [];
  for (const r of tracked.rows) {
    const [did, pdsUrl] = r as [string, string | null];
    const mirrorRes = await db.execute({
      sql: "SELECT COUNT(*) FROM bookmarks WHERE did = ?",
      args: [did],
    });
    const mirror = Number(mirrorRes.rows[0]?.[0] ?? 0);

    let pds: number | null = null;
    let pdsError: string | null = null;
    if (pdsUrl) {
      try {
        pds = await countPdsBookmarks(pdsUrl, did);
      } catch (err) {
        pdsError = String(err);
      }
    } else {
      pdsError = "no pds_url";
    }
    rows.push({ did, pdsUrl, mirror, pds, pdsError });

    // Progress signal on stderr so stdout stays clean for --json.
    if (!jsonOut) {
      const tag = pdsError
        ? `ERROR ${pdsError}`
        : `mirror=${mirror} pds=${pds} diff=${(pds ?? 0) - mirror}`;
      console.error(`[audit] ${did} ${tag}`);
    }
  }

  if (jsonOut) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }

  rows.sort((a, b) => {
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
  for (const r of rows) {
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
    `tracked=${rows.length} divergent=${divergent} recoverable=${recoverable}`,
  );
}

await main();
