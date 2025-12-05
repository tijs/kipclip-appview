// Database module using Turso/libSQL
// Works on Deno Deploy and local development

const dbUrl = Deno.env.get("TURSO_DATABASE_URL") || "file:.local/kipclip.db";
const isLocal = dbUrl.startsWith("file:");
const isTestDb = dbUrl.startsWith("libsql://test");

// For test environment with fake URL, use a mock client
let rawDb: {
  execute: (
    query: { sql: string; args: unknown[] },
  ) => Promise<{ rows: unknown[][] }>;
};

if (isTestDb) {
  // Mock client for tests - doesn't actually connect
  console.log("✅ Using mock database (test mode)");
  rawDb = {
    execute: (
      _query: { sql: string; args: unknown[] },
    ): Promise<{ rows: unknown[][] }> => {
      // Return empty results for all queries in test mode
      return Promise.resolve({ rows: [] });
    },
  };
} else {
  // Use native client for local file, web client for remote Turso
  const { createClient } = isLocal
    ? await import("npm:@libsql/client@0.15.15")
    : await import("npm:@libsql/client@0.15.15/web");

  const client = createClient({
    url: dbUrl,
    authToken: Deno.env.get("TURSO_AUTH_TOKEN"),
  });

  // Wrap the client to provide a consistent interface
  // The libSQL client returns Row objects, we convert to arrays for compatibility
  rawDb = {
    execute: async (
      query: { sql: string; args: unknown[] },
    ): Promise<{ rows: unknown[][] }> => {
      const result = await client.execute({
        sql: query.sql,
        args: query.args as any,
      });
      // Convert Row objects to arrays (Object.values)
      const rows = result.rows.map((row) => Object.values(row));
      return { rows };
    },
  };

  console.log(`✅ Using ${isLocal ? "local" : "Turso"} database`);
}

export { rawDb };

// Initialize tables using migrations
export async function initializeTables() {
  // Skip migrations for test database
  if (isTestDb) {
    console.log("⏭️ Skipping migrations (test mode)");
    return;
  }
  const { runMigrations } = await import("./migrations.ts");
  await runMigrations();
}
