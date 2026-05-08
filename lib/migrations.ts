// Database migrations for kipclip
// SQLiteStorage creates iron_session_storage automatically on first use.
// Migration 005 backfills columns added in atproto-storage@1.1.0 for existing installs.

import { db, remoteDb } from "./db.ts";
import { MIRROR_MIGRATIONS } from "../mirror/schema.ts";

// Migration tracking table
const MIGRATIONS_TABLE = `
  CREATE TABLE IF NOT EXISTS migrations (
    id INTEGER PRIMARY KEY,
    version TEXT UNIQUE NOT NULL,
    description TEXT NOT NULL,
    executed_at TEXT DEFAULT CURRENT_TIMESTAMP
  )
`;

// Non-mirror migrations: sessions / user_settings / import_jobs.
// These live on the primary db. The remote Turso backup only mirrors tables.
const NON_MIRROR_MIGRATIONS: Array<{
  version: string;
  description: string;
  sql: string;
}> = [
  {
    version: "001",
    description: "Create user_settings table",
    sql: `
      CREATE TABLE IF NOT EXISTS user_settings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        did TEXT NOT NULL UNIQUE,
        reading_list_tag TEXT NOT NULL DEFAULT 'toread',
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_user_settings_did ON user_settings(did)
    `,
  },
  {
    version: "002",
    description: "Add Instapaper integration fields to user_settings",
    sql: `
      ALTER TABLE user_settings ADD COLUMN instapaper_enabled INTEGER DEFAULT 0;
      ALTER TABLE user_settings ADD COLUMN instapaper_username_encrypted TEXT;
      ALTER TABLE user_settings ADD COLUMN instapaper_password_encrypted TEXT
    `,
  },
  {
    version: "003",
    description: "Create import_jobs and import_chunks tables",
    sql: `
      CREATE TABLE IF NOT EXISTS import_jobs (
        id TEXT PRIMARY KEY,
        did TEXT NOT NULL,
        format TEXT NOT NULL,
        total INTEGER NOT NULL DEFAULT 0,
        skipped INTEGER NOT NULL DEFAULT 0,
        imported INTEGER NOT NULL DEFAULT 0,
        failed INTEGER NOT NULL DEFAULT 0,
        total_chunks INTEGER NOT NULL DEFAULT 0,
        processed_chunks INTEGER NOT NULL DEFAULT 0,
        tags TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL DEFAULT 'pending',
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_import_jobs_did ON import_jobs(did);
      CREATE TABLE IF NOT EXISTS import_chunks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id TEXT NOT NULL,
        chunk_index INTEGER NOT NULL,
        bookmarks TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (job_id) REFERENCES import_jobs(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_import_chunks_job ON import_chunks(job_id, chunk_index)
    `,
  },
  {
    version: "004",
    description: "Stamp supporter verification on import_jobs",
    sql: `
      ALTER TABLE import_jobs ADD COLUMN supporter_verified_at TEXT
    `,
  },
  {
    // SQLiteStorage@1.1.0 added created_at/updated_at columns. Existing tables
    // created by the old 3-column schema need them backfilled. NOT NULL DEFAULT
    // '' satisfies the NOT NULL constraint for pre-existing rows.
    // CREATE TABLE runs first so fresh DBs get the full schema immediately;
    // ALTER TABLE then adds the columns to existing 3-column installs.
    // Both steps may be no-ops depending on the current schema — errors for
    // "already exists" and "duplicate column name" are swallowed by the runner.
    version: "005",
    description: "Add created_at and updated_at to iron_session_storage",
    sql: `
      CREATE TABLE IF NOT EXISTS iron_session_storage (key TEXT PRIMARY KEY, value TEXT NOT NULL, expires_at TEXT, created_at TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL DEFAULT '');
      ALTER TABLE iron_session_storage ADD COLUMN created_at TEXT NOT NULL DEFAULT '';
      ALTER TABLE iron_session_storage ADD COLUMN updated_at TEXT NOT NULL DEFAULT ''
    `,
  },
];

// Combined list applied to the primary db.
const MIGRATIONS = [...NON_MIRROR_MIGRATIONS, ...MIRROR_MIGRATIONS];

interface DbClient {
  execute: (
    query: { sql: string; args: unknown[] },
  ) => Promise<{ rows: unknown[][] }>;
}

interface MigrationEntry {
  version: string;
  description: string;
  sql: string;
}

async function runMigrationSet(
  db: DbClient,
  label: string,
  migrations: MigrationEntry[],
): Promise<void> {
  // Create migrations table on this connection.
  await db.execute({ sql: MIGRATIONS_TABLE, args: [] });

  // Get already executed migrations on this connection.
  const executed = await db.execute({
    sql: "SELECT version FROM migrations ORDER BY id",
    args: [],
  });

  const executedVersions = new Set(
    executed.rows?.map((row: any) => {
      if (Array.isArray(row)) return row[0] as string;
      return row.version as string;
    }) || [],
  );

  const pending = migrations.filter((m) => !executedVersions.has(m.version));
  if (pending.length === 0) {
    console.log(`✅ ${label} schema up to date`);
    return;
  }

  console.log(
    `🔄 Running ${pending.length} pending migration(s) on ${label}...`,
  );

  for (const migration of pending) {
    console.log(
      `📝 Running migration on ${label}: ${migration.version} - ${migration.description}`,
    );

    const statements = migration.sql
      .split(";")
      .map((stmt) => stmt.trim())
      .filter((stmt) => stmt.length > 0);

    let migrationSucceeded = true;
    for (const statement of statements) {
      try {
        await db.execute({ sql: statement, args: [] });
      } catch (error) {
        const msg = (error as Error).message ?? "";
        if (msg.includes("already exists") || msg.includes("duplicate column name")) {
          console.warn(
            `⚠️  Schema already up to date on ${label}, skipping: ${msg}`,
          );
        } else {
          console.error(
            `❌ Migration statement failed on ${label}: ${
              (error as Error).message
            }`,
          );
          migrationSucceeded = false;
          throw error;
        }
      }
    }

    if (migrationSucceeded) {
      try {
        await db.execute({
          sql: "INSERT INTO migrations (version, description) VALUES (?, ?)",
          args: [migration.version, migration.description],
        });
        console.log(`✅ Completed migration on ${label}: ${migration.version}`);
      } catch (error) {
        if ((error as Error).message?.includes("UNIQUE constraint")) {
          console.log(
            `ℹ️  Migration ${migration.version} already recorded on ${label}`,
          );
        } else {
          throw error;
        }
      }
    }
  }
}

export async function runMigrations() {
  try {
    // Primary db gets every migration: sessions, settings, import_jobs,
    // and mirror tables.
    await runMigrationSet(db, "primary", MIGRATIONS);

    // Remote Turso only needs the mirror tables. Skip silently when
    // TURSO_DATABASE_URL is unset (Deno Deploy, dev without remote backup).
    if (remoteDb) {
      await runMigrationSet(remoteDb, "Turso remote", MIRROR_MIGRATIONS);
    }

    console.log("✅ All migrations completed successfully");
  } catch (error) {
    console.error("❌ Migration failed:", error);
    throw error;
  }
}

export async function getMigrationStatus() {
  try {
    await db.execute({
      sql: MIGRATIONS_TABLE,
      args: [],
    });
    const result = await db.execute({
      sql:
        "SELECT version, description, executed_at FROM migrations ORDER BY id",
      args: [],
    });
    return result.rows || [];
  } catch (error) {
    console.error("Failed to get migration status:", error);
    return [];
  }
}
