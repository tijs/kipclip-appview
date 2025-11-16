/**
 * Local SQLite adapter for development.
 * Wraps Deno's native SQLite to match Val.Town's sqlite2 API.
 */

import { Database } from "jsr:@db/sqlite@0.12";

interface SqliteRow {
  [key: string]: unknown;
}

interface SqliteResult {
  columns: string[];
  rows: unknown[][];
}

type SqliteBindValue =
  | string
  | number
  | boolean
  | null
  | Uint8Array
  | bigint
  | Date;

interface ExecuteOptions {
  sql: string;
  args?: SqliteBindValue[];
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

  const db = new Database(dbPath);

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
          // Deno SQLite returns objects, but we need arrays to match Val.Town's API
          const objectRows = db.prepare(sql).all(...args) as SqliteRow[];

          if (objectRows.length === 0) {
            return Promise.resolve({ columns: [], rows: [] });
          }

          // Extract column names from first row
          const columns = Object.keys(objectRows[0]);

          // Convert object rows to array rows
          const rows = objectRows.map((obj) => columns.map((col) => obj[col]));

          return Promise.resolve({ columns, rows });
        }

        // For queries that modify data (INSERT, UPDATE, DELETE, CREATE, etc.)
        // Note: CREATE TABLE IF NOT EXISTS won't throw if table exists
        db.prepare(sql).run(...args);
        return Promise.resolve({ columns: [], rows: [] });
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
