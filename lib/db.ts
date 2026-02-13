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
    ? await import("@libsql/client")
    : await import("@libsql/client/web");

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

// Initialize tables using migrations (with retry for transient Turso errors)
export async function initializeTables() {
  // Skip migrations for test database
  if (isTestDb) {
    console.log("⏭️ Skipping migrations (test mode)");
    return;
  }
  const { runMigrations } = await import("./migrations.ts");

  const maxRetries = 3;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await runMigrations();
      return;
    } catch (error) {
      const isTransient = error instanceof Error &&
        (error.message.includes("502") ||
          error.message.includes("503") ||
          error.message.includes("bad gateway") ||
          error.message.includes("ECONNREFUSED"));

      if (isTransient && attempt < maxRetries) {
        const delay = attempt * 2000;
        console.warn(
          `⚠️ Migration attempt ${attempt}/${maxRetries} failed (transient), retrying in ${delay}ms...`,
        );
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      throw error;
    }
  }
}
