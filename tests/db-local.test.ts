/**
 * Tests for primary db initialization + migration coverage.
 *
 * The full lib/db.ts module branches on env vars at import time, so these
 * tests focus on the observable behaviors:
 *   - Without TURSO_DATABASE_URL, remoteDb is null.
 *   - db is always initialized and accepts queries.
 *   - All tables (sessions, settings, mirror) land on the primary db.
 *
 * The test setup (mirror-test-setup.ts) imports db.ts under the test env
 * (DATABASE_URL=file::memory: + no TURSO_DATABASE_URL by default), so the
 * remoteDb export is null in the default test mode.
 */

import "./test-setup.ts";
import "./mirror-test-setup.ts";

import { assertEquals } from "@std/assert";
import { db, remoteDb } from "../lib/db.ts";

Deno.test("remoteDb is null when TURSO_DATABASE_URL is unset", () => {
  // Default test env doesn't set TURSO_DATABASE_URL.
  assertEquals(remoteDb, null);
});

Deno.test("db is initialized in test mode", async () => {
  // Sanity: in-memory db is up and accepts queries.
  const r = await db.execute({ sql: "SELECT 1", args: [] });
  assertEquals(r.rows.length, 1);
});

Deno.test("mirror tables exist on db (initializeTables already ran)", async () => {
  const r = await db.execute({
    sql:
      "SELECT name FROM sqlite_master WHERE type='table' AND name='bookmarks'",
    args: [],
  });
  assertEquals(r.rows.length, 1);
});

Deno.test("non-mirror tables (user_settings, import_jobs) exist on db", async () => {
  const tables = ["user_settings", "import_jobs", "import_chunks"];
  for (const t of tables) {
    const r = await db.execute({
      sql: "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
      args: [t],
    });
    assertEquals(r.rows.length, 1, `${t} should exist on db`);
  }
});
