// Database module using Turso/libSQL.
//
// Two distinct DB connections, both libSQL-protocol:
//   - tursoDb (also exported as rawDb for backwards compat) — the durable
//     remote DB. Holds sessions, user_settings, import_jobs, AND the mirror
//     tables. Always initialized.
//   - localDb — optional local libSQL file on the box. When LOCAL_DB_URL is
//     set, mirror tables are also created here and writes/reads can be
//     dual-routed via the mirrorDb facade introduced in plan 004.
//
// localDb is null on Deno Deploy and any environment that does not set
// LOCAL_DB_URL — code paths that depend on dual-write must check for null
// or use the helpers in mirror/* which honor the MIRROR_DUAL_WRITE flag.

const dbUrl = Deno.env.get("TURSO_DATABASE_URL") || "file:.local/kipclip.db";
const isLocal = dbUrl.startsWith("file:");
const isTestDb = dbUrl.startsWith("libsql://test");

const localDbUrl = Deno.env.get("LOCAL_DB_URL");

interface DbClient {
  execute: (
    query: { sql: string; args: unknown[] },
  ) => Promise<{ rows: unknown[][] }>;
}

let rawDb: DbClient;
let localDb: DbClient | null = null;

if (isTestDb) {
  // Mock client for tests - doesn't actually connect
  console.error("✅ Using mock database (test mode)");
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

  console.error(`✅ Using ${isLocal ? "local" : "Turso"} database`);

  // Optional second connection: local libSQL on the box. Only used when the
  // operator opts in by setting LOCAL_DB_URL. Always file: scheme — a remote
  // libSQL URL here would defeat the point (local-fast reads).
  if (localDbUrl) {
    if (!localDbUrl.startsWith("file:")) {
      console.warn(
        `⚠️ LOCAL_DB_URL must use file: scheme; got "${localDbUrl}" — ignoring`,
      );
    } else {
      const { createClient: createLocalClient } = await import(
        "@libsql/client"
      );
      const localClient = createLocalClient({ url: localDbUrl });
      localDb = {
        execute: async (
          query: { sql: string; args: unknown[] },
        ): Promise<{ rows: unknown[][] }> => {
          const result = await localClient.execute({
            sql: query.sql,
            args: query.args as any,
          });
          const rows = result.rows.map((row) => Object.values(row));
          return { rows };
        },
      };
      console.error(`✅ Local libSQL initialized at ${localDbUrl}`);
    }
  }
}

export { localDb, rawDb };

/**
 * Test-only: install a fake localDb so suites can exercise the dual-write
 * code path without provisioning a real local libSQL file. Pass null to
 * restore the default (no local DB).
 */
export function _setTestLocalDb(db: typeof localDb): void {
  localDb = db;
}

/**
 * Returns true when dual-write should fan out (local authoritative + Turso
 * best-effort). False when either the env flag is off OR localDb wasn't
 * initialized — in which case writes go to Turso only (legacy behavior).
 */
export function mirrorWriteEnabled(): boolean {
  return Deno.env.get("MIRROR_DUAL_WRITE") === "on" && localDb !== null;
}

/**
 * Mirror write: dual-write when enabled, single-write otherwise.
 *
 * Dual-write semantics:
 *   - Local libSQL is authoritative. The promise resolves only after the
 *     local write succeeds. Local failure rejects, so callers (e.g. the TAP
 *     webhook) can return 5xx and let TAP retry.
 *   - Turso is best-effort. The Turso write is dispatched in parallel and
 *     awaited, but on failure we capture a Sentry warning and resolve
 *     successfully. A Turso outage must not cause webhook retry storms; the
 *     mirror catches up via the next TAP delivery (idempotent upserts).
 *
 * Sentry signal: "mirror dual-write: turso failed" (warning level).
 */
export async function mirrorWrite(query: {
  sql: string;
  args: unknown[];
}): Promise<void> {
  if (mirrorWriteEnabled() && localDb) {
    // Run both in parallel: local must succeed (await), Turso can fail (catch).
    const tursoPromise = rawDb.execute(query).catch(async (err) => {
      const { captureMessage } = await import("./sentry.ts");
      captureMessage(
        "mirror dual-write: turso failed",
        "warning",
        {
          sql: query.sql.split("\n")[0]?.trim().slice(0, 120),
          error: String(err),
        },
      );
    });
    await localDb.execute(query);
    // Don't await Turso — but don't drop it either. Allow the webhook to
    // return 200 the moment local commits; Turso settles in background.
    // Floating promise is intentional and the catch above prevents an
    // unhandled rejection.
    void tursoPromise;
    return;
  }
  await rawDb.execute(query);
}

/**
 * Mirror read: try local libSQL first when dual-write is enabled, fall back
 * to Turso on failure. Returns Turso directly when dual-write is off.
 *
 * The fn callback receives whichever client is being attempted so callers
 * can write `mirrorRead((db) => db.execute({sql, args}))` without juggling
 * connection objects themselves.
 *
 * Sentry signal: "mirror read fallback: local→turso" (warning level).
 */
export async function mirrorRead<T>(
  fn: (db: { execute: typeof rawDb.execute }) => Promise<T>,
): Promise<T> {
  if (mirrorWriteEnabled() && localDb) {
    try {
      return await fn(localDb);
    } catch (err) {
      const { captureMessage } = await import("./sentry.ts");
      captureMessage(
        "mirror read fallback: local→turso",
        "warning",
        { error: String(err) },
      );
      return await fn(rawDb);
    }
  }
  return await fn(rawDb);
}

// Initialize tables using migrations (with retry for transient Turso errors)
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
