#!/usr/bin/env -S deno run -A
/**
 * One-time migration: copy iron_session_storage from Turso → local SQLite.
 *
 * Run BEFORE switching the box env vars from Turso-primary to local-primary:
 *
 *   TURSO_DATABASE_URL=libsql://...  (OLD primary, source of sessions)
 *   TURSO_AUTH_TOKEN=...
 *   DATABASE_URL=file:/var/lib/kipclip/kipclip.db  (NEW primary, destination)
 *   deno run -A scripts/migrate-sessions-to-local.ts
 *
 * Safety guards:
 *   - Requires both TURSO_DATABASE_URL and DATABASE_URL. Exits 1 if missing.
 *   - Refuses to run if DATABASE_URL is an in-memory file (file::memory:).
 *   - Connects independently — does NOT import from lib/db.ts.
 *   - Uses INSERT OR IGNORE so re-runs are safe.
 *   - Prints a summary: "Copied N rows, skipped M (already existed)".
 */

const tursoUrl = Deno.env.get("TURSO_DATABASE_URL");
const tursoToken = Deno.env.get("TURSO_AUTH_TOKEN");
const localUrl = Deno.env.get("DATABASE_URL");

const missing: string[] = [];
if (!tursoUrl) missing.push("TURSO_DATABASE_URL");
if (!localUrl) missing.push("DATABASE_URL");

if (missing.length > 0) {
  console.error(
    `ERROR: missing required env vars: ${missing.join(", ")}`,
  );
  console.error(
    "  TURSO_DATABASE_URL — the old Turso primary (source of sessions)",
  );
  console.error(
    "  DATABASE_URL — the new local SQLite primary (destination)",
  );
  Deno.exit(1);
}

if (!localUrl!.startsWith("file:") || localUrl === "file::memory:") {
  console.error(
    `ERROR: DATABASE_URL must be a real file path (got "${localUrl}").`,
  );
  console.error(
    "  Refusing to run against an in-memory or non-file database.",
  );
  Deno.exit(1);
}

if (tursoUrl!.startsWith("file:")) {
  console.error(
    `ERROR: TURSO_DATABASE_URL must be a remote libsql:// URL (got "${tursoUrl}").`,
  );
  console.error(
    "  This script copies FROM Turso TO local SQLite.",
  );
  Deno.exit(1);
}

console.log(`Source (Turso): ${tursoUrl}`);
console.log(`Destination (local): ${localUrl}`);
console.log();

// Connect to Turso (source).
const { createClient: createWebClient } = await import("@libsql/client/web");
const tursoClient = createWebClient({
  url: tursoUrl!,
  authToken: tursoToken,
});

// Connect to local SQLite (destination).
const { createClient: createLocalClient } = await import("@libsql/client");
const localClient = createLocalClient({ url: localUrl! });

// Ensure the destination table exists with the current SQLiteStorage@1.1.0+ schema.
const CREATE_TABLE = `
  CREATE TABLE IF NOT EXISTS iron_session_storage (
    key TEXT PRIMARY KEY NOT NULL,
    value TEXT NOT NULL,
    expires_at TEXT,
    created_at TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL DEFAULT ''
  )
`;
await localClient.execute(CREATE_TABLE);

// Read all rows from Turso.
console.log("Reading iron_session_storage from Turso...");
let sourceRows: { key: string; value: string; expires_at: number | null }[];
try {
  const result = await tursoClient.execute({
    sql: "SELECT key, value, expires_at FROM iron_session_storage",
    args: [],
  });
  sourceRows = result.rows.map((row) => ({
    key: String(row[0] ?? row.key),
    value: String(row[1] ?? row.value),
    expires_at: row[2] != null ? Number(row[2] ?? row.expires_at) : null,
  }));
} catch (err) {
  console.error(`ERROR: Failed to read from Turso: ${err}`);
  Deno.exit(1);
}

console.log(`Found ${sourceRows.length} rows in Turso.`);

if (sourceRows.length === 0) {
  console.log("Nothing to migrate.");
  Deno.exit(0);
}

// Copy rows to local SQLite using INSERT OR IGNORE.
let copied = 0;
let skipped = 0;

for (const row of sourceRows) {
  const result = await localClient.execute({
    sql: `INSERT OR IGNORE INTO iron_session_storage (key, value, expires_at)
          VALUES (?, ?, ?)`,
    args: [row.key, row.value, row.expires_at],
  });
  if (result.rowsAffected === 1) {
    copied++;
  } else {
    skipped++;
  }
}

console.log(`\nCopied ${copied} rows, skipped ${skipped} (already existed).`);
console.log("✅ Session migration complete.");
console.log(
  "\nNext steps:",
);
console.log(
  "  1. Update box env: set DATABASE_URL=file:/var/lib/kipclip/kipclip.db",
);
console.log(
  "  2. Optionally set TURSO_DATABASE_URL for mirror dual-write backup",
);
console.log(
  "  3. Restart the kipclip service",
);
