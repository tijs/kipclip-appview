/**
 * Tests for primary db initialization + migration coverage.
 */

import "./test-setup.ts";
import "./mirror-test-setup.ts";

import { assertEquals } from "@std/assert";
import { db } from "../lib/db.ts";

Deno.test("db is initialized in test mode", async () => {
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
