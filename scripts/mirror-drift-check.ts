#!/usr/bin/env -S deno run -A
/**
 * Compare row counts between local libSQL and Turso for the dual-write
 * mirror tables. Reports per-table deltas and per-DID deltas where they
 * exist.
 *
 * Drift in steady-state should always be zero — TAP delivers each event
 * once and the dual-write helper is idempotent on both sides. Non-zero
 * drift is a Sentry-worthy event the U5 readiness window watches for.
 *
 * Usage:
 *   LOCAL_DB_URL=file:/var/lib/kipclip/mirror.db \
 *   TURSO_DATABASE_URL=libsql://... TURSO_AUTH_TOKEN=... \
 *   deno run -A scripts/mirror-drift-check.ts
 *
 * Exits 0 when both stores match. Exits 1 on any mismatch.
 */

// Validate required env BEFORE importing lib/db.ts. The shared module
// eagerly opens both connections at import time and crashes with an
// opaque libSQL error 14 if TURSO_DATABASE_URL is unset (it falls back
// to file:.local/kipclip.db which does not exist on the box). Fail fast
// with an operator-friendly message instead.
const missing: string[] = [];
if (!Deno.env.get("LOCAL_DB_URL")) missing.push("LOCAL_DB_URL");
if (!Deno.env.get("TURSO_DATABASE_URL")) missing.push("TURSO_DATABASE_URL");
if (!Deno.env.get("TURSO_AUTH_TOKEN")) missing.push("TURSO_AUTH_TOKEN");
if (missing.length > 0) {
  console.error(
    `ERROR: missing required env: ${missing.join(", ")}. ` +
      `Source /etc/kipclip/env or pass vars inline (see usage at top of file).`,
  );
  Deno.exit(2);
}

const { localDb, rawDb } = await import("../lib/db.ts");

if (!localDb) {
  console.error(
    "ERROR: LOCAL_DB_URL did not initialize a local client. Check the URL scheme (must be file:).",
  );
  Deno.exit(2);
}

const TABLES = [
  "bookmarks",
  "annotations",
  "tags",
  "tracked_dids",
  "preferences",
];

interface CountRow {
  table: string;
  local: number;
  turso: number;
  delta: number;
}

const results: CountRow[] = [];
let totalDelta = 0;

for (const table of TABLES) {
  const [localR, tursoR] = await Promise.all([
    localDb!.execute({ sql: `SELECT COUNT(*) FROM ${table}`, args: [] }),
    rawDb.execute({ sql: `SELECT COUNT(*) FROM ${table}`, args: [] }),
  ]);
  const local = Number((localR.rows[0] as unknown[])[0] ?? 0);
  const turso = Number((tursoR.rows[0] as unknown[])[0] ?? 0);
  const delta = local - turso;
  results.push({ table, local, turso, delta });
  totalDelta += Math.abs(delta);
}

console.log("\nTable-level drift");
console.log("─".repeat(60));
console.log(
  `${"table".padEnd(16)} ${"local".padStart(10)} ${"turso".padStart(10)} ${
    "delta".padStart(10)
  }`,
);
console.log("─".repeat(60));
for (const r of results) {
  const flag = r.delta === 0 ? "" : " ⚠";
  console.log(
    `${r.table.padEnd(16)} ${String(r.local).padStart(10)} ${
      String(r.turso).padStart(10)
    } ${String(r.delta).padStart(10)}${flag}`,
  );
}

// Per-DID drill-down for any drifting table. Only when the table is
// expected to have multiple DIDs (skip preferences which is one row per DID
// max).
const driftingTables = results.filter((r) => r.delta !== 0).map((r) => r.table);
if (driftingTables.length > 0) {
  console.log("\nPer-DID breakdown for drifting tables");
  console.log("─".repeat(80));
  for (const table of driftingTables) {
    if (table === "preferences") {
      // preferences has no aggregate-by-did view; skip.
      continue;
    }
    const [localR, tursoR] = await Promise.all([
      localDb!.execute({
        sql: `SELECT did, COUNT(*) FROM ${table} GROUP BY did ORDER BY did`,
        args: [],
      }),
      rawDb.execute({
        sql: `SELECT did, COUNT(*) FROM ${table} GROUP BY did ORDER BY did`,
        args: [],
      }),
    ]);
    const localMap = new Map<string, number>();
    for (const row of localR.rows as unknown[][]) {
      localMap.set(String(row[0]), Number(row[1]));
    }
    const tursoMap = new Map<string, number>();
    for (const row of tursoR.rows as unknown[][]) {
      tursoMap.set(String(row[0]), Number(row[1]));
    }
    const dids = new Set([...localMap.keys(), ...tursoMap.keys()]);
    console.log(`\n  ${table}:`);
    for (const did of [...dids].sort()) {
      const l = localMap.get(did) ?? 0;
      const t = tursoMap.get(did) ?? 0;
      const d = l - t;
      if (d === 0) continue;
      console.log(
        `    ${did.padEnd(40)} local=${l} turso=${t} delta=${d}`,
      );
    }
  }
}

console.log();
if (totalDelta === 0) {
  console.log("✅ No drift detected. Both stores agree.");
  Deno.exit(0);
}
console.log(`⚠️  Drift detected: ${totalDelta} rows total across all tables.`);
console.log(
  "Investigate Sentry for 'mirror dual-write' / 'mirror read fallback' signals.",
);
console.log(
  "Recovery: replay TAP getRepo against the lagging store, or re-trigger backfill.",
);
Deno.exit(1);
