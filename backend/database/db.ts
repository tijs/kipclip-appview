// Database module using Turso/libSQL
// Works on Deno Deploy and local development

import { createTursoHttpClient, type TursoClient } from "./turso-http.ts";

const dbUrl = Deno.env.get("TURSO_DATABASE_URL") || "file:.local/kipclip.db";
const isLocal = dbUrl.startsWith("file:");

let client: TursoClient;

if (isLocal) {
  // Local development: use native libSQL client with file database
  const { createClient } = await import("npm:@libsql/client@0.15.15");
  const libsqlClient = createClient({ url: dbUrl });
  // Wrap to match TursoClient interface
  client = {
    execute: async (query: { sql: string; args?: unknown[] }) => {
      const result = await libsqlClient.execute({
        sql: query.sql,
        args: (query.args ?? []) as any,
      });
      const rows = result.rows.map((row) => Object.values(row));
      return { rows };
    },
  };
} else {
  // Remote Turso: use our pure fetch-based HTTP client (no npm dependencies)
  client = createTursoHttpClient({
    url: dbUrl,
    authToken: Deno.env.get("TURSO_AUTH_TOKEN"),
  });
}

// Export for use by valTownAdapter and other modules
export const rawDb = {
  execute: async (
    query: { sql: string; args: unknown[] },
  ): Promise<{ rows: unknown[][] }> => {
    const result = await client.execute({
      sql: query.sql,
      args: query.args,
    });
    return { rows: result.rows as unknown[][] };
  },
};

console.log(`✅ Using ${isLocal ? "local" : "Turso HTTP"} database`);

// Initialize tables using migrations
export async function initializeTables() {
  const { runMigrations } = await import("./migrations.ts");
  await runMigrations();
}
