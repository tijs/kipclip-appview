/**
 * One-shot mirror recovery for a tracked DID whose `bookmarks`/`tags`/
 * `annotations` mirror tables are empty (or partial) but whose PDS holds
 * the authoritative records.
 *
 * Re-runs the same backfill the auto-enroll path uses, against the
 * primary local SQLite. Idempotent — upserts use ON CONFLICT.
 *
 * Sanity-checks the supplied PDS URL against the DID's actual endpoint
 * from plc.directory so a typo doesn't silently report `bookmarks=0`
 * against the wrong host.
 *
 * Usage (run on the box where DATABASE_URL points at the primary db):
 *
 *   deno run --allow-net --allow-env --allow-read --allow-write \
 *     scripts/recover-mirror.ts <did> <pds-url>
 *
 * Example:
 *
 *   deno run -A scripts/recover-mirror.ts \
 *     did:plc:sna3qx44beg2mb5fao44gsxh https://pds.samantha.wiki
 */

import { runBackfill } from "../lib/auto-enroll.ts";
import { db } from "../lib/db.ts";
import { resolveDid } from "../lib/plc-resolver.ts";

async function main() {
  const [did, pdsUrl] = Deno.args;
  if (!did || !pdsUrl) {
    console.error("usage: recover-mirror.ts <did> <pdsUrl>");
    Deno.exit(2);
  }

  const resolved = await resolveDid(did);
  if (!resolved) {
    console.error(
      `[recover-mirror] could not resolve ${did} via plc.directory`,
    );
    Deno.exit(3);
  }
  if (resolved.pdsUrl !== pdsUrl) {
    console.error(
      `[recover-mirror] PDS mismatch: arg=${pdsUrl} but DID resolves to ` +
        `${resolved.pdsUrl}. Pass --force to override.`,
    );
    if (!Deno.args.includes("--force")) Deno.exit(4);
  }

  console.log(`[recover-mirror] starting for ${did} (pds=${pdsUrl})`);
  const t0 = Date.now();
  await runBackfill(did, pdsUrl);
  const t1 = Date.now();

  const counts = await db.execute({
    sql: `
      SELECT
        (SELECT COUNT(*) FROM bookmarks WHERE did = ?) AS bookmarks,
        (SELECT COUNT(*) FROM annotations WHERE did = ?) AS annotations,
        (SELECT COUNT(*) FROM tags WHERE did = ?) AS tags
    `,
    args: [did, did, did],
  });
  // lib/db.ts strips column names via Object.values(row), so destructure
  // positionally — accessing by name would print `undefined` for every count.
  const [bookmarks, annotations, tags] = (counts.rows[0] ?? [0, 0, 0]) as Array<
    number | bigint
  >;
  console.log(
    `[recover-mirror] complete in ${t1 - t0}ms — ` +
      `bookmarks=${bookmarks} annotations=${annotations} tags=${tags}`,
  );
}

await main();
