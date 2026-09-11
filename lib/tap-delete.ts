/**
 * Verified TAP-side repo-row deletion.
 *
 * Destructive TAP operators (the drift quarantine batch and the
 * approval-gated tap-only cleanup) MUST read back the exact target after
 * deletion: a DELETE that leaves a row behind — or that a caller cannot
 * confirm — must be reported as a failure, never claimed successful. This
 * helper deletes the requested DIDs and then re-selects the exact same set;
 * any surviving row throws, and callers surface the failure instead of
 * logging a success line.
 *
 * `removed` lists DIDs whose row was actually deleted; `alreadyAbsent`
 * lists DIDs that had no TAP row (idempotent no-op — TAP /repos/remove is
 * idempotent, and so is this). tracked_dids / missing_repos / mirror rows
 * are never touched here.
 */

import { withTapDb } from "./tap-db.ts";

function placeholders(n: number): string {
  return Array.from({ length: n }, () => "?").join(",");
}

export interface TapDeleteResult {
  removed: string[];
  alreadyAbsent: string[];
}

/**
 * The minimal execute surface deleteTapRepoRowsWithClient needs — shaped
 * like the @libsql/client result set (positional-array rows). Keeping this
 * an interface lets the read-back logic be tested with a fake client
 * instead of a native libsql file handle.
 */
export interface TapExecuteClient {
  execute(query: {
    sql: string;
    args?: unknown[];
  }): Promise<{ rows: unknown[][] }>;
}

/**
 * Core deletion logic against an already-open client: SELECT-before/after
 * the DELETE so the read-back is exact. Throws when any intended target
 * survives (or the DELETE itself fails) — a caller must never treat a
 * failed deletion as success. Kept separate from deleteTapRepoRows so the
 * verification logic is unit-testable without opening a TAP db file.
 */
export async function deleteTapRepoRowsWithClient(
  tapClient: TapExecuteClient,
  dids: string[],
): Promise<TapDeleteResult> {
  if (dids.length === 0) return { removed: [], alreadyAbsent: [] };
  const before = await tapClient.execute({
    sql: `SELECT did FROM repos WHERE did IN (${placeholders(dids.length)})`,
    args: dids,
  });
  const present = new Set(before.rows.map((r) => String(r[0])));

  await tapClient.execute({
    sql: `DELETE FROM repos WHERE did IN (${placeholders(dids.length)})`,
    args: dids,
  });

  // Read back the exact target: every intended deletion must actually be
  // gone now. A surviving row is a failure — report it, never claim
  // success.
  const remaining = await tapClient.execute({
    sql: `SELECT did FROM repos WHERE did IN (${placeholders(dids.length)})`,
    args: dids,
  });
  if (remaining.rows.length > 0) {
    const stuck = remaining.rows.map((r) => String(r[0]));
    throw new Error(
      `read-back verification failed: still present in TAP repos: ${
        stuck.join(", ")
      }`,
    );
  }

  return {
    removed: dids.filter((d) => present.has(d)),
    alreadyAbsent: dids.filter((d) => !present.has(d)),
  };
}

/**
 * Delete the given DIDs from TAP's `repos` table and verify the exact
 * target is gone. Throws when the read-back finds any surviving row or when
 * the DELETE itself fails — a caller must never treat a failed deletion as
 * success.
 */
export function deleteTapRepoRows(
  dids: string[],
  opts?: { tapDbPath?: string },
): Promise<TapDeleteResult> {
  if (dids.length === 0) {
    return Promise.resolve({ removed: [], alreadyAbsent: [] });
  }
  return withTapDb(
    opts,
    (tapClient) => deleteTapRepoRowsWithClient(tapClient, dids),
  );
}
