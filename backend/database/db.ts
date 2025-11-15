// Drizzle ORM database module with environment-aware configuration
import { drizzle } from "https://esm.sh/drizzle-orm@0.44.5/sqlite-proxy";
import * as schema from "./schema.ts";

// Detect environment - check for Val.Town specific environment variable
// Val.Town sets DENO_REGION, local dev won't have this
const isValTown = Deno.env.get("DENO_REGION") !== undefined;

// Use Val.Town sqlite in production, local adapter in development
let rawDb: any;
if (isValTown) {
  const { sqlite } = await import("https://esm.town/v/std/sqlite2");
  rawDb = sqlite;
} else {
  const { createLocalSqlite } = await import("./local-sqlite.ts");
  rawDb = createLocalSqlite();
}

// Create Drizzle database instance with schema using sqlite-proxy adapter
export const db = drizzle(
  async (sql, params, method) => {
    console.log(`[SQLITE-PROXY] method=${method}, sql=${sql.substring(0, 100)}, params=`, params);
    const result = await rawDb.execute({ sql, args: params || [] });
    console.log(`[SQLITE-PROXY] result=`, result);
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
