import { getHost } from "../runtime/host.ts";
// Database module using libSQL.
//
// Single db connection backed by the primary local SQLite file on the box
// (DATABASE_URL=file:/var/lib/kipclip/kipclip.db). In local dev it defaults
// to file:.local/kipclip.db. Holds all tables: OAuth sessions, user_settings,
// import_jobs, and all mirror tables.

const dbUrl = getHost().env.get("DATABASE_URL") || "file:.local/kipclip.db";
const isLocal = dbUrl.startsWith("file:");
const isTestDb = dbUrl.startsWith("libsql://test");

export interface DbExecutor {
  execute: (
    query: { sql: string; args: unknown[] },
  ) => Promise<{ rows: unknown[][]; rowsAffected: number }>;
  /** A libSQL write batch commits all statements together or rolls back. */
  batch: (queries: { sql: string; args: unknown[] }[]) => Promise<void>;
}

interface DbClient extends DbExecutor {
  /** Hold a short write transaction; never perform network I/O inside it. */
  transaction<T>(run: (tx: DbExecutor) => Promise<T>): Promise<T>;
}

let db: DbClient;

if (isTestDb) {
  // Mock client for tests - doesn't actually connect
  console.error("✅ Using mock database (test mode)");
  db = {
    transaction: (run) => run(db),
    batch: () => Promise.resolve(),
    execute: (
      _query: { sql: string; args: unknown[] },
    ): Promise<{ rows: unknown[][]; rowsAffected: number }> => {
      // Return empty results for all queries in test mode
      return Promise.resolve({ rows: [], rowsAffected: 0 });
    },
  };
} else {
  const client = getHost().createDatabase({
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

  const executorFor = (connection: any): DbExecutor => ({
    execute: async (query) => {
      const result = await connection.execute(query);
      return {
        rows: result.rows.map((row: any) => Object.values(row)),
        rowsAffected: Number(result.rowsAffected ?? 0),
      };
    },
    batch: async (queries) => {
      await connection.batch(queries, "write");
    },
  });
  const raw = executorFor(client);
  // Keep ordinary calls outside callback transactions on this connection.
  // Local libSQL transaction() detaches its connection, which also loses an
  // anonymous in-memory database; use BEGIN/COMMIT on the existing connection.
  let tail = Promise.resolve();
  const exclusive = <T>(run: () => Promise<T>): Promise<T> => {
    const result = tail.then(run);
    tail = result.then(() => {}, () => {});
    return result;
  };
  db = {
    execute: (query) => exclusive(() => raw.execute(query)),
    batch: (queries) => exclusive(() => raw.batch(queries)),
    transaction: (run) =>
      exclusive(async () => {
        if (isLocal) {
          await client.execute("BEGIN IMMEDIATE");
          const tx: DbExecutor = {
            ...raw,
            batch: async (queries) => {
              for (const query of queries) await raw.execute(query);
            },
          };
          try {
            const result = await run(tx);
            await client.execute("COMMIT");
            return result;
          } catch (error) {
            await client.execute("ROLLBACK");
            throw error;
          }
        }
        const tx = await client.transaction("write");
        try {
          const result = await run(executorFor(tx));
          await tx.commit();
          return result;
        } catch (error) {
          await tx.rollback();
          throw error;
        } finally {
          tx.close();
        }
      }),
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
