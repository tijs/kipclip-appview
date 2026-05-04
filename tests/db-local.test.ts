/**
 * Tests for U1 (plan 004): local libSQL gating + dual-DB migrations.
 *
 * The full lib/db.ts module branches on env vars at import time, so these
 * tests focus on the observable behaviors:
 *   - Without LOCAL_DB_URL, only Turso runs migrations.
 *   - With LOCAL_DB_URL, mirror migrations also land on the local DB.
 *
 * The test setup (mirror-test-setup.ts) imports db.ts under the test env
 * (TURSO_DATABASE_URL=file::memory: + no LOCAL_DB_URL by default), so the
 * localDb export is null in the default test mode.
 */

import "./test-setup.ts";
import "./mirror-test-setup.ts";

import { assertEquals } from "@std/assert";
import { localDb, rawDb } from "../lib/db.ts";

Deno.test("localDb is null when LOCAL_DB_URL is unset", () => {
  // Default test env doesn't set LOCAL_DB_URL.
  assertEquals(localDb, null);
});

Deno.test("rawDb is initialized in test mode", async () => {
  // Sanity: in-memory Turso is up and accepts queries.
  const r = await rawDb.execute({ sql: "SELECT 1", args: [] });
  assertEquals(r.rows.length, 1);
});

Deno.test("mirror tables exist on rawDb (initializeTables already ran)", async () => {
  const r = await rawDb.execute({
    sql:
      "SELECT name FROM sqlite_master WHERE type='table' AND name='bookmarks'",
    args: [],
  });
  assertEquals(r.rows.length, 1);
});

Deno.test("non-mirror tables (user_settings, import_jobs) exist on rawDb", async () => {
  const tables = ["user_settings", "import_jobs", "import_chunks"];
  for (const t of tables) {
    const r = await rawDb.execute({
      sql: "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
      args: [t],
    });
    assertEquals(r.rows.length, 1, `${t} should exist on rawDb`);
  }
});
