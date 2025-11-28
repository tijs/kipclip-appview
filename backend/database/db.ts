// Database module with environment-aware configuration

// Use Val.Town sqlite in production, local adapter in development
const isProduction = Deno.env.get("ENVIRONMENT") === "PRODUCTION";

let rawDb: any;
if (isProduction) {
  const { sqlite } = await import("https://esm.town/v/std/sqlite2");
  rawDb = sqlite;
  console.log("✅ Using Val.Town SQLite (production)");
} else {
  const { createLocalSqlite } = await import("./local-sqlite.ts");
  rawDb = createLocalSqlite();
  console.log("✅ Using local SQLite (development)");
}

// Export raw database for migrations and OAuth storage
export { rawDb };

// Initialize tables using migrations
export async function initializeTables() {
  const { runMigrations } = await import("./migrations.ts");
  await runMigrations();
}
