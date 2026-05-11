/**
 * One-shot mirror recovery for a tracked DID whose `bookmarks`/`tags`/
 * `annotations` mirror tables are empty (or partial) but whose PDS holds
 * the authoritative records.
 *
 * Re-runs the same backfill the auto-enroll path uses, against the
 * primary local SQLite. Idempotent — upserts use ON CONFLICT.
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

async function main() {
  const [did, pdsUrl] = Deno.args;
  if (!did || !pdsUrl) {
    console.error("usage: recover-mirror.ts <did> <pdsUrl>");
    Deno.exit(2);
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
  const row = counts.rows[0] as Record<string, unknown>;
  console.log(
    `[recover-mirror] complete in ${t1 - t0}ms — ` +
      `bookmarks=${row.bookmarks} annotations=${row.annotations} ` +
      `tags=${row.tags}`,
  );
}

await main();
