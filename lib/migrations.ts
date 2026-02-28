// Database migrations for kipclip
// SQLiteStorage creates the iron_session_storage table automatically
// This file is kept for future application-specific migrations

import { rawDb } from "./db.ts";

// Migration tracking table
const MIGRATIONS_TABLE = `
  CREATE TABLE IF NOT EXISTS migrations (
    id INTEGER PRIMARY KEY,
    version TEXT UNIQUE NOT NULL,
    description TEXT NOT NULL,
    executed_at TEXT DEFAULT CURRENT_TIMESTAMP
  )
`;

// List of all migrations in order
// SQLiteStorage handles iron_session_storage table creation
const MIGRATIONS: Array<{
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
];

export async function runMigrations() {
  console.log("🔄 Running database migrations...");

  try {
    // Create migrations table
    await rawDb.execute({
      sql: MIGRATIONS_TABLE,
      args: [],
    });

    // Get already executed migrations
    const executed = await rawDb.execute({
      sql: "SELECT version FROM migrations ORDER BY id",
      args: [],
    });

    // Get executed versions - handle both object rows and array rows
    const executedVersions = new Set(
      executed.rows?.map((row: any) => {
        // If row is an array, use first element
        if (Array.isArray(row)) return row[0] as string;
        // If row is an object, use the version property
        return row.version as string;
      }) || [],
    );

    // Run pending migrations
    for (const migration of MIGRATIONS) {
      if (!executedVersions.has(migration.version)) {
        console.log(
          `📝 Running migration: ${migration.version} - ${migration.description}`,
        );

        // Split SQL into individual statements (SQLite limitation)
        const statements = migration.sql
          .split(";")
          .map((stmt) => stmt.trim())
          .filter((stmt) => stmt.length > 0);

        // Execute each statement
        let migrationSucceeded = true;
        for (const statement of statements) {
          try {
            await rawDb.execute({
              sql: statement,
              args: [],
            });
          } catch (error) {
            // If it's a "table already exists" error, that's fine - continue
            if (error.message?.includes("already exists")) {
              console.warn(
                `⚠️  Table already exists, skipping: ${error.message}`,
              );
            } else {
              // For other errors, mark migration as failed
              console.error(`❌ Migration statement failed: ${error.message}`);
              migrationSucceeded = false;
              throw error;
            }
          }
        }

        // Only record migration if all statements succeeded
        if (migrationSucceeded) {
          // Check if migration was already recorded (could happen on retry)
          try {
            await rawDb.execute({
              sql:
                "INSERT INTO migrations (version, description) VALUES (?, ?)",
              args: [migration.version, migration.description],
            });
            console.log(`✅ Completed migration: ${migration.version}`);
          } catch (error) {
            if (error.message?.includes("UNIQUE constraint")) {
              console.log(
                `ℹ️  Migration ${migration.version} already recorded`,
              );
            } else {
              throw error;
            }
          }
        }
      }
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
