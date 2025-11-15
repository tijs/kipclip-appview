/**
 * Local SQLite adapter for development.
 * Wraps Deno's native SQLite to match Val.Town's sqlite2 API.
 */

import { Database } from "jsr:@db/sqlite@0.12";

interface SqliteRow {
  [key: string]: unknown;
}

interface SqliteResult {
  rows: SqliteRow[];
}

interface ExecuteOptions {
  sql: string;
  args?: unknown[];
}

/**
 * Creates a local SQLite database adapter that matches Val.Town's sqlite2 API.
 *
 * @param dbPath - Path to SQLite database file (default: .local/kipclip.db)
 * @returns Database adapter with execute() method
 */
export function createLocalSqlite(dbPath = ".local/kipclip.db") {
  // Ensure .local directory exists
  try {
    Deno.mkdirSync(".local", { recursive: true });
  } catch (err) {
    if (!(err instanceof Deno.errors.AlreadyExists)) {
      throw err;
    }
  }

  // Create database with int64 mode to handle JavaScript timestamps (> 2^31)
  // Without this, timestamps get truncated to 32-bit signed integers
  const db = new Database(dbPath, { int64: true });

  return {
    /**
     * Execute SQL query with optional parameters.
     * Matches Val.Town's sqlite2.execute() API.
     */
    execute(options: ExecuteOptions): Promise<SqliteResult> {
      const { sql, args = [] } = options;

      try {
        // For queries that return data (SELECT)
        if (sql.trim().toUpperCase().startsWith("SELECT")) {
          // Deno SQLite returns objects by default, which is what we want
          const rows = db.prepare(sql).all(...args) as SqliteRow[];
          return { rows };
        }

        // For queries that modify data (INSERT, UPDATE, DELETE, CREATE, etc.)
        // Note: CREATE TABLE IF NOT EXISTS won't throw if table exists
        db.prepare(sql).run(...args);
        return { rows: [] };
      } catch (error) {
        // Re-throw error without logging (migrations will handle it)
        throw error;
      }
    },

    /**
     * Close the database connection.
     * Call this when shutting down the dev server.
     */
    close() {
      db.close();
    },
  };
}
