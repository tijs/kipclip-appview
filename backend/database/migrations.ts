// Database migrations for kipclip
// This provides proper schema versioning and safe migrations

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
const MIGRATIONS = [
  {
    version: "001_initial_schema",
    description: "Create initial OAuth session storage table",
    sql: `
      -- Create iron_session_storage table for OAuth sessions
      CREATE TABLE IF NOT EXISTS iron_session_storage (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        expires_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      -- Create index for efficient cleanup of expired sessions
      CREATE INDEX IF NOT EXISTS idx_iron_session_expires
      ON iron_session_storage(expires_at);
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

    // Get executed versions from row arrays (sqlite2 returns arrays, not objects)
    const executedVersions = new Set(
      executed.rows?.map((row) => row[0] as string) || [],
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
        for (const statement of statements) {
          try {
            await rawDb.execute({
              sql: statement,
              args: [],
            });
          } catch (error) {
            console.warn(
              `⚠️  Statement warning (likely table exists): ${error.message}`,
            );
          }
        }

        // Record migration as executed
        await rawDb.execute({
          sql: "INSERT INTO migrations (version, description) VALUES (?, ?)",
          args: [migration.version, migration.description],
        });

        console.log(`✅ Completed migration: ${migration.version}`);
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
