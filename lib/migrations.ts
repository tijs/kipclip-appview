// Database migrations for kipclip
// SQLiteStorage creates the iron_session_storage table automatically
// This file is kept for future application-specific migrations

import { localDb, rawDb } from "./db.ts";
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
// These live exclusively on Turso. Local libSQL on the box does not need them.
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
];

// Combined list applied to Turso (rawDb).
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
        if ((error as Error).message?.includes("already exists")) {
          console.warn(
            `⚠️  Table already exists on ${label}, skipping: ${
              (error as Error).message
            }`,
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
    // Turso (rawDb) gets every migration: sessions, settings, import_jobs,
    // and mirror tables.
    await runMigrationSet(rawDb, "Turso", MIGRATIONS);

    // Local libSQL on the box only needs the mirror tables. Skip silently
    // when LOCAL_DB_URL is unset (Deno Deploy, dev without box).
    if (localDb) {
      await runMigrationSet(localDb, "local libSQL", MIRROR_MIGRATIONS);
    }

    console.log("✅ All migrations completed successfully");
  } catch (error) {
    console.error("❌ Migration failed:", error);
    throw error;
  }
}

export async function getMigrationStatus() {
  try {
    await rawDb.execute({
      sql: MIGRATIONS_TABLE,
      args: [],
    });
    const result = await rawDb.execute({
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
