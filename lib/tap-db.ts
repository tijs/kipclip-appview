/**
 * Shared helper for executing SQL against TAP's local SQLite database.
 *
 * Used by drift-alert and forwarding-audit for read-only / cleanup queries.
 * TAP is a separate process, but on the box its state lives in a local file
 * that the kipclip user can read (and, for cleanup, write).
 */

const DEFAULT_TAP_DB_PATH = "/var/lib/tap/tap.db";

export interface TapDbOptions {
  tapDbPath?: string;
}

export function tapDbPath(opts?: TapDbOptions): string {
  const envPath = Deno.env.get("TAP_DB_PATH");
  return opts?.tapDbPath ??
    (envPath && envPath.length > 0 ? envPath : DEFAULT_TAP_DB_PATH);
}

/**
 * Execute a callback with a temporary libSQL client open to TAP's database.
 * Returns the callback result. Errors are propagated — callers decide whether
 * to fail open or closed.
 */
export async function withTapDb<T>(
  opts: TapDbOptions | undefined,
  fn: (client: any) => Promise<T>,
): Promise<T> {
  const path = tapDbPath(opts);
  // deno-lint-ignore no-explicit-any
  let tapClient: any;
  try {
    const { createClient } = await import("@libsql/client");
    tapClient = createClient({ url: `file:${path}` });
    return await fn(tapClient);
  } finally {
    try {
      tapClient?.close();
    } catch { /* best-effort */ }
  }
}
