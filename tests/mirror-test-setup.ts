/**
 * Test setup for mirror tests. Relies on the `deno task test` env which sets
 * DATABASE_URL=file::memory: + COOKIE_SECRET. Migrations are run on
 * import so mirror tables exist before any test runs. Tables are shared across
 * tests in the same process; tests must call clearMirrorTables() at start.
 */

import { db, initializeTables } from "../lib/db.ts";
import { _resetSyncStatusCache } from "../lib/mirror-config.ts";

await initializeTables();

export { db };

export async function clearMirrorTables(): Promise<void> {
  await db.execute({ sql: "DELETE FROM bookmarks", args: [] });
  await db.execute({ sql: "DELETE FROM annotations", args: [] });
  await db.execute({ sql: "DELETE FROM tags", args: [] });
  await db.execute({ sql: "DELETE FROM tracked_dids", args: [] });
  await db.execute({ sql: "DELETE FROM preferences", args: [] });
  await db.execute({ sql: "DELETE FROM seen_webhook_deliveries", args: [] });
  await db.execute({ sql: "DELETE FROM preview_enrichment_jobs", args: [] });
  // tracked_dids drives shouldReadFromMirror's getSyncStatus result; the
  // 1s TTL cache would otherwise serve stale tracking state across tests.
  _resetSyncStatusCache();
}
