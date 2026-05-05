#!/usr/bin/env -S deno run -A
/**
 * Dump every user table in Turso as plain SQL to stdout.
 *
 * Discovers tables at runtime from sqlite_master so new migrations don't
 * need to update this file. Uses the same TURSO_DATABASE_URL +
 * TURSO_AUTH_TOKEN the app already has, so no extra auth setup needed.
 *
 * Output is BEGIN/COMMIT-wrapped CREATE TABLE + INDEX + INSERT statements
 * that replay against an empty Turso DB or a local sqlite file.
 *
 * Fail-loud: any per-table read error aborts the whole dump rather than
 * emitting a silent partial. The backup script's empty-file check
 * combined with a CREATE-TABLE count check (deploy/restic-backup.sh)
 * catches partial dumps even if this contract regresses.
 *
 * Usage (single source of env via /etc/kipclip/env):
 *   sudo -u kipclip bash -c '
 *     set -a; source /etc/kipclip/env; set +a; \
 *     /opt/deno/bin/deno run -A scripts/dump-turso-tables.ts > /tmp/turso-dump.sql
 *   '
 */

import { rawDb } from "../lib/db.ts";

const SQLITE_MAX_INT = 9223372036854775807n; // 2^63 - 1
const SQLITE_MIN_INT = -9223372036854775808n; // -2^63

function quoteSqlValue(v: unknown): string {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "boolean") return v ? "1" : "0";
  if (typeof v === "number") {
    if (!Number.isFinite(v)) {
      throw new Error(`non-finite number cannot be dumped: ${v}`);
    }
    return String(v);
  }
  if (typeof v === "bigint") {
    if (v > SQLITE_MAX_INT || v < SQLITE_MIN_INT) {
      throw new Error(`bigint out of SQLite INTEGER range: ${v}`);
    }
    return v.toString();
  }
  if (v instanceof Uint8Array) {
    // BLOB → X'hex'
    const hex = Array.from(v)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    return `X'${hex}'`;
  }
  if (typeof v === "string") {
    return `'${v.replace(/'/g, "''")}'`;
  }
  throw new Error(
    `unsupported value type for dump: ${typeof v} (${
      Object.prototype.toString.call(v)
    })`,
  );
}

// Discover tables at runtime. Excludes sqlite internal tables and any
// virtual-table shadow tables (which have a NULL sql column anyway).
const tablesR = await rawDb.execute({
  sql:
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND sql IS NOT NULL ORDER BY name",
  args: [],
});
const TABLES = (tablesR.rows ?? []).map((row) => String(row[0]));

if (TABLES.length === 0) {
  throw new Error("no user tables found in source DB; refusing to dump");
}

console.log("BEGIN TRANSACTION;");

for (const table of TABLES) {
  // Schema. Loud failure: any error here aborts the whole dump so the
  // backup script never stores a non-empty but partial snapshot.
  const schemaR = await rawDb.execute({
    sql:
      "SELECT sql FROM sqlite_master WHERE type='table' AND name = ? AND sql IS NOT NULL",
    args: [table],
  });
  if (!schemaR.rows || schemaR.rows.length === 0) {
    throw new Error(`schema not found for table ${table}`);
  }
  const createSql = String(schemaR.rows[0][0]);
  console.log(`\n-- ${table}`);
  console.log(`DROP TABLE IF EXISTS ${table};`);
  console.log(`${createSql};`);

  // Index DDL for the table.
  const idxR = await rawDb.execute({
    sql:
      "SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name = ? AND sql IS NOT NULL",
    args: [table],
  });
  for (const row of idxR.rows ?? []) {
    console.log(`${String(row[0])};`);
  }

  // Column names for INSERT. Use pragma_table_info table-valued form so
  // we don't depend on Object.values insertion order in the wrapper.
  const colsR = await rawDb.execute({
    sql: "SELECT name FROM pragma_table_info(?)",
    args: [table],
  });
  const colNames = (colsR.rows ?? []).map((row) => String(row[0]));
  if (colNames.length === 0) {
    throw new Error(`pragma_table_info returned no columns for ${table}`);
  }
  const colList = colNames.map((c) => `"${c}"`).join(", ");

  // Data.
  const dataR = await rawDb.execute({
    sql: `SELECT ${colList} FROM ${table}`,
    args: [],
  });
  const rows = dataR.rows ?? [];
  for (const row of rows) {
    const values = row.map(quoteSqlValue).join(", ");
    console.log(`INSERT INTO ${table} (${colList}) VALUES (${values});`);
  }
  console.error(`-- ${table}: ${rows.length} rows`);
}

console.log("\nCOMMIT;");
