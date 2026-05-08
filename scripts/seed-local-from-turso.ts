#!/usr/bin/env -S deno run -A
/**
 * One-shot: copy mirror tables from remote Turso → primary local SQLite.
 *
 * Used at cutover to seed the box's primary local SQLite with whatever
 * Turso has accumulated. After dual-write is enabled, running this would
 * overwrite newer local rows with stale Turso state via PK collision —
 * the script refuses to run when MIRROR_DUAL_WRITE=on.
 *
 * Idempotent across re-runs that occur BEFORE dual-write is enabled. Each
 * table is wrapped in a transaction so a mid-run crash leaves the local
 * DB internally consistent.
 *
 * Usage (on the box, with the same env as the kipclip app):
 *   sudo -u kipclip bash -c '
 *     set -a; source /etc/kipclip/env; set +a; \
 *     /opt/deno/bin/deno run -A scripts/seed-local-from-turso.ts
 *   '
 */

import { db, remoteDb } from "../lib/db.ts";

if (!remoteDb) {
  console.error(
    "ERROR: remoteDb is null. Set TURSO_DATABASE_URL=libsql://... and TURSO_AUTH_TOKEN=...",
  );
  Deno.exit(2);
}

if (Deno.env.get("MIRROR_DUAL_WRITE") === "on") {
  console.error(
    "ERROR: refusing to seed while MIRROR_DUAL_WRITE=on — would overwrite",
  );
  console.error(
    "       newer local rows with stale Turso state. Set MIRROR_DUAL_WRITE=off",
  );
  console.error(
    "       (or unset) and re-run only if this is the cutover one-shot.",
  );
  Deno.exit(2);
}

const MIRROR_TABLES = [
  "tracked_dids",
  "bookmarks",
  "annotations",
  "tags",
  "preferences",
];

let total = 0;

for (const name of MIRROR_TABLES) {
  // Discover columns at runtime so a future ALTER on local doesn't
  // silently drop the new column at cutover.
  const colsR = await db.execute({
    sql: "SELECT name FROM pragma_table_info(?)",
    args: [name],
  });
  const cols = (colsR.rows ?? []).map((row) => String(row[0]));
  if (cols.length === 0) {
    throw new Error(`primary db has no columns for ${name}; aborting`);
  }
  const colList = cols.join(", ");
  const placeholders = cols.map(() => "?").join(", ");

  console.log(`==> Reading ${name} from remote Turso...`);
  const r = await remoteDb.execute({
    sql: `SELECT ${colList} FROM ${name}`,
    args: [],
  });
  const rows = r.rows ?? [];
  console.log(`    ${rows.length} rows`);

  if (rows.length === 0) continue;

  console.log(
    `==> Writing ${name} to primary local SQLite (in transaction)...`,
  );
  await db.execute({ sql: "BEGIN", args: [] });
  try {
    for (const row of rows) {
      await db.execute({
        sql:
          `INSERT OR REPLACE INTO ${name} (${colList}) VALUES (${placeholders})`,
        args: row,
      });
    }
    await db.execute({ sql: "COMMIT", args: [] });
  } catch (err) {
    await db.execute({ sql: "ROLLBACK", args: [] }).catch(() => {});
    throw err;
  }
  total += rows.length;
  console.log(`    done`);
}

console.log(`\n✅ Seeded ${total} rows into primary local SQLite.`);
console.log("Run scripts/mirror-drift-check.ts to verify zero drift.");
