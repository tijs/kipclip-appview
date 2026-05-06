/**
 * Test setup for mirror tests. Relies on the `deno task test` env which sets
 * TURSO_DATABASE_URL=file::memory: + COOKIE_SECRET. Migrations are run on
 * import so mirror tables exist before any test runs. Tables are shared across
 * tests in the same process; tests must call clearMirrorTables() at start.
 */

import { initializeTables, rawDb } from "../lib/db.ts";

await initializeTables();

export { rawDb };

export async function clearMirrorTables(): Promise<void> {
  await rawDb.execute({ sql: "DELETE FROM bookmarks", args: [] });
  await rawDb.execute({ sql: "DELETE FROM annotations", args: [] });
  await rawDb.execute({ sql: "DELETE FROM tags", args: [] });
  await rawDb.execute({ sql: "DELETE FROM tracked_dids", args: [] });
  await rawDb.execute({ sql: "DELETE FROM preferences", args: [] });
  await rawDb.execute({ sql: "DELETE FROM seen_webhook_events", args: [] });
}
