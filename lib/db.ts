// Database module using libSQL.
//
// Single db connection backed by the primary local SQLite file on the box
// (DATABASE_URL=file:/var/lib/kipclip/kipclip.db). In local dev it defaults
// to file:.local/kipclip.db. Holds all tables: OAuth sessions, user_settings,
// import_jobs, and all mirror tables.

const dbUrl = Deno.env.get("DATABASE_URL") || "file:.local/kipclip.db";
const isLocal = dbUrl.startsWith("file:");
const isTestDb = dbUrl.startsWith("libsql://test");

interface DbClient {
  execute: (
    query: { sql: string; args: unknown[] },
  ) => Promise<{ rows: unknown[][]; rowsAffected: number }>;
}

let db: DbClient;

if (isTestDb) {
  // Mock client for tests - doesn't actually connect
  console.error("✅ Using mock database (test mode)");
  db = {
    execute: (
      _query: { sql: string; args: unknown[] },
    ): Promise<{ rows: unknown[][]; rowsAffected: number }> => {
      // Return empty results for all queries in test mode
      return Promise.resolve({ rows: [], rowsAffected: 0 });
    },
  };
} else {
  const { createClient } = await import("@libsql/client");

  const client = createClient({
    url: dbUrl,
  });

  // SQLite pragmas for local file connections only.
  if (isLocal) {
    await client.execute("PRAGMA busy_timeout = 5000");
    await client.execute("PRAGMA cache_size = -65536");
    // NORMAL: flushes at checkpoints, not every commit. Survives process
    // crashes; OS crash can lose the last ~1-2 committed transactions.
    // Acceptable tradeoff for a bookmark manager.
    await client.execute("PRAGMA synchronous = NORMAL");
  }

  // Wrap the client to provide a consistent interface.
  // The libSQL client returns Row objects; convert to arrays for compatibility.
  db = {
    execute: async (
      query: { sql: string; args: unknown[] },
    ): Promise<{ rows: unknown[][]; rowsAffected: number }> => {
      const result = await client.execute({
        sql: query.sql,
        args: query.args as any,
      });
      const rows = result.rows.map((row) => Object.values(row));
      return { rows, rowsAffected: Number(result.rowsAffected ?? 0) };
    },
  };

  console.error(`✅ Using ${isLocal ? "local" : "remote"} database`);
}

export { db };

// Initialize tables using migrations (with retry for transient errors)
export async function initializeTables() {
  // Skip migrations for test database
  if (isTestDb) {
    console.error("⏭️ Skipping migrations (test mode)");
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
          error.message.includes("ECONNREFUSED") ||
          error.message.includes("connection not opened"));

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
