// Drizzle ORM database module with environment-aware configuration
import { drizzle } from "https://esm.sh/drizzle-orm@0.44.5/sqlite-proxy";
import * as schema from "./schema.ts";

// Use Val.Town sqlite in production, local adapter in development
// Detect Val.Town by checking if we're running from esm.town URL
const isValTown = import.meta.url.startsWith("https://esm.town/");

let rawDb: any;
if (isValTown) {
  const { sqlite } = await import("https://esm.town/v/std/sqlite2");
  rawDb = sqlite;
  console.log("✅ Using Val.Town SQLite");
} else {
  const { createLocalSqlite } = await import("./local-sqlite.ts");
  rawDb = createLocalSqlite();
  console.log("✅ Using local SQLite");
}

// Create Drizzle database instance with schema using sqlite-proxy adapter
export const db = drizzle(
  async (sql, params) => {
    const result = await rawDb.execute({ sql, args: params || [] });
    return { rows: result.rows };
  },
  { schema },
);

// Export raw database for migrations and schema operations
export { rawDb };

// Initialize all tables using Drizzle migrations
export async function initializeTables() {
  // Run proper Drizzle-based migrations
  const { runMigrations } = await import("./migrations.ts");
  await runMigrations();
}
