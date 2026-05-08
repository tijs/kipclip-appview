// Database module using libSQL.
//
// Two distinct DB connections, both libSQL-protocol:
//   - db (primary) — always initialized. Uses native @libsql/client for
//     file: scheme, web client for remote. Holds sessions, user_settings,
//     import_jobs, AND the mirror tables. This is the authoritative store.
//   - remoteDb — optional Turso remote for mirror dual-write backup.
//     Only initialized when TURSO_DATABASE_URL is set and is not a file: URL.
//     remoteDb is null on any environment that does not set TURSO_DATABASE_URL
//     — code paths that depend on dual-write must check for null or use the
//     helpers in mirror/* which honor the MIRROR_DUAL_WRITE flag.

const dbUrl = Deno.env.get("DATABASE_URL") || "file:.local/kipclip.db";
const isLocal = dbUrl.startsWith("file:");
const isTestDb = dbUrl.startsWith("libsql://test");

const remoteDbUrl = Deno.env.get("TURSO_DATABASE_URL");

interface DbClient {
  execute: (
    query: { sql: string; args: unknown[] },
  ) => Promise<{ rows: unknown[][]; rowsAffected: number }>;
}

let db: DbClient;
let remoteDb: DbClient | null = null;

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
  // Use native client for local file, web client for remote
  const { createClient } = isLocal
    ? await import("@libsql/client")
    : await import("@libsql/client/web");

  const client = createClient({
    url: dbUrl,
    authToken: Deno.env.get("TURSO_AUTH_TOKEN"),
  });

  // Wrap the client to provide a consistent interface
  // The libSQL client returns Row objects, we convert to arrays for compatibility
  db = {
    execute: async (
      query: { sql: string; args: unknown[] },
    ): Promise<{ rows: unknown[][]; rowsAffected: number }> => {
      const result = await client.execute({
        sql: query.sql,
        args: query.args as any,
      });
      // Convert Row objects to arrays (Object.values)
      const rows = result.rows.map((row) => Object.values(row));
      return { rows, rowsAffected: Number(result.rowsAffected ?? 0) };
    },
  };

  console.error(`✅ Using ${isLocal ? "local" : "remote"} database`);

  // Optional second connection: remote Turso for mirror dual-write backup.
  // Only used when the operator opts in by setting TURSO_DATABASE_URL to a
  // remote libsql:// URL. A file: URL here would be nonsensical (the primary
  // is already local) and is rejected.
  if (remoteDbUrl) {
    if (remoteDbUrl.startsWith("file:")) {
      console.warn(
        `⚠️ TURSO_DATABASE_URL must use a remote URL; got "${remoteDbUrl}" — ignoring`,
      );
    } else {
      // Open the remote connection in a try/catch so a transient Turso outage
      // at boot does NOT crash the whole service. mirrorWrite() still writes
      // to the primary db; the remote backup is best-effort.
      try {
        const { createClient: createRemoteClient } = await import(
          "@libsql/client/web"
        );
        const remoteClient = createRemoteClient({
          url: remoteDbUrl,
          authToken: Deno.env.get("TURSO_AUTH_TOKEN"),
        });
        remoteDb = {
          execute: async (
            query: { sql: string; args: unknown[] },
          ): Promise<{ rows: unknown[][]; rowsAffected: number }> => {
            const result = await remoteClient.execute({
              sql: query.sql,
              args: query.args as any,
            });
            const rows = result.rows.map((row) => Object.values(row));
            return { rows, rowsAffected: Number(result.rowsAffected ?? 0) };
          },
        };
        console.error(`✅ Remote Turso mirror initialized at ${remoteDbUrl}`);
      } catch (err) {
        console.warn(
          `⚠️ Failed to open remote Turso at ${remoteDbUrl}: ${
            String(err)
          } — continuing primary-only`,
        );
        try {
          const { captureMessage } = await import("./sentry.ts");
          captureMessage(
            "mirror remote init failed: continuing primary-only",
            "error",
            { error: String(err), url: remoteDbUrl },
          );
        } catch { /* sentry optional at boot */ }
        remoteDb = null;
      }
    }
  }
}

export { db, remoteDb };

/**
 * Session-aware dual-write client. Wraps the primary db but fans out non-SELECT
 * queries to remoteDb synchronously when MIRROR_DUAL_WRITE=on. Both writes must
 * succeed — unlike mirror tables (which can re-sync via TAP), sessions cannot be
 * recovered from PDS, so a silent remote failure on logout would leave a phantom
 * valid session on the Deno Deploy fallback instance.
 *
 * Pass to sqliteAdapter() in oauth-config.ts instead of the bare db.
 */
export const sessionDb: DbClient = {
  execute: async (
    query: { sql: string; args: unknown[] },
  ): Promise<{ rows: unknown[][]; rowsAffected: number }> => {
    const isWrite = !/^\s*SELECT\b/i.test(query.sql);
    if (isWrite && mirrorWriteEnabled() && remoteDb) {
      const [primaryResult] = await Promise.all([
        db.execute(query),
        remoteDb.execute(query),
      ]);
      return primaryResult;
    }
    return db.execute(query);
  },
};

/**
 * Test-only: install a fake remoteDb so suites can exercise the dual-write
 * code path without provisioning a real remote Turso connection. Pass null to
 * restore the default (no remote DB).
 */
export function _setTestRemoteDb(fakeDb: typeof remoteDb): void {
  remoteDb = fakeDb;
}

/**
 * Returns true when dual-write should fan out (primary authoritative + Turso
 * best-effort). False when either the env flag is off OR remoteDb wasn't
 * initialized — in which case writes go to db only.
 */
export function mirrorWriteEnabled(): boolean {
  return Deno.env.get("MIRROR_DUAL_WRITE") === "on" && remoteDb !== null;
}

/**
 * Mirror write: dual-write when enabled, single-write otherwise.
 *
 * Dual-write semantics:
 *   - Primary db is authoritative. The promise resolves only after the
 *     primary write succeeds. Primary failure rejects, so callers (e.g. the
 *     TAP webhook) can return 5xx and let TAP retry.
 *   - Remote Turso is best-effort. The remote write is dispatched in parallel
 *     and awaited, but on failure we capture a Sentry warning and resolve
 *     successfully. A Turso outage must not cause webhook retry storms; the
 *     mirror catches up via the next TAP delivery (idempotent upserts).
 *
 * Sentry signal: "mirror dual-write: remote failed" (warning level).
 */
export async function mirrorWrite(query: {
  sql: string;
  args: unknown[];
}): Promise<void> {
  if (mirrorWriteEnabled() && remoteDb) {
    // Primary must succeed (await); remote can fail (catch).
    const remotePromise = remoteDb.execute(query).catch(async (err) => {
      const { captureMessage } = await import("./sentry.ts");
      captureMessage(
        "mirror dual-write: remote failed",
        "warning",
        {
          sql: query.sql.split("\n")[0]?.trim().slice(0, 120),
          error: String(err),
        },
      );
    });
    await db.execute(query);
    // Don't await remote — but don't drop it either. Allow the webhook to
    // return 200 the moment primary commits; remote settles in background.
    // Floating promise is intentional and the catch above prevents an
    // unhandled rejection.
    void remotePromise;
    return;
  }
  await db.execute(query);
}

/**
 * Mirror read: always uses the primary db, which is always local and
 * authoritative.
 *
 * The fn callback receives the primary db client so callers can write
 * `mirrorRead((db) => db.execute({sql, args}))` without juggling connection
 * objects themselves.
 */
export async function mirrorRead<T>(
  fn: (client: DbClient) => Promise<T>,
): Promise<T> {
  return await fn(db);
}

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
