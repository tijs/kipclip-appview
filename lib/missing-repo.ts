/**
 * Persistent tracking of repos confirmed missing (deleted/deactivated accounts
 * or defunct PDSs). Used by auto-enroll and drift-audit to back off retries,
 * skip rechecks inside the cooldown window, and quarantine candidates (TAP
 * enrollment removal only — local tracking data is never auto-deleted).
 */

import { db } from "./db.ts";
import { ListRecordsError } from "./mirror-sync.ts";

/** Re-check a missing repo only after this cooldown (7 days). */
export const MISSING_REPO_RECHECK_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;

/** Cap on the persisted `last_error` text — first line, bounded length. A raw,
 * unbounded PDS error detail must never grow the stored row (or any report
 * that reads it). */
const MAX_PERSISTED_ERROR_LEN = 200;

export interface MissingRepoRow {
  did: string;
  first_missing_at: number;
  last_missing_at: number;
  missing_count: number;
  last_error: string | null;
}

/** First non-empty line of an error, capped at MAX_PERSISTED_ERROR_LEN
 * (null when there is nothing worth storing). Mirrors the bounded-summary
 * convention used elsewhere (lib/pds-error.ts errorSummary). */
function boundedErrorText(error?: string): string | null {
  if (!error) return null;
  const line = (error.split("\n")[0] ?? "").trim();
  if (line.length === 0) return null;
  return line.length > MAX_PERSISTED_ERROR_LEN
    ? line.slice(0, MAX_PERSISTED_ERROR_LEN - 1) + "…"
    : line;
}

/**
 * Record that a repo is confirmed missing. Preserves the first-seen timestamp
 * and bumps the counter. Call this only for clear RepoNotFound-style failures,
 * not transient network errors. The error text is bounded before persisting:
 * first line, ≤ MAX_PERSISTED_ERROR_LEN chars — never a raw/unbounded payload.
 */
export async function recordMissingRepo(
  did: string,
  error?: string,
): Promise<void> {
  const now = Date.now();
  await db.execute({
    sql: `
      INSERT INTO missing_repos
        (did, first_missing_at, last_missing_at, missing_count, last_error)
      VALUES (?, ?, ?, 1, ?)
      ON CONFLICT(did) DO UPDATE SET
        last_missing_at = excluded.last_missing_at,
        missing_count = missing_repos.missing_count + 1,
        last_error = excluded.last_error
    `,
    args: [did, now, now, boundedErrorText(error)],
  });
}

/** Clear a missing-repo record, e.g. when a repo comes back or is removed. */
export async function forgetMissingRepo(did: string): Promise<void> {
  await db.execute({
    sql: "DELETE FROM missing_repos WHERE did = ?",
    args: [did],
  });
}

/**
 * True if the DID is recorded missing and the last confirmation is within the
 * supplied window (usually MISSING_REPO_RECHECK_COOLDOWN_MS).
 */
export async function isMissingRepo(
  did: string,
  windowMs: number,
): Promise<boolean> {
  const cutoff = Date.now() - windowMs;
  const res = await db.execute({
    sql: "SELECT 1 FROM missing_repos WHERE did = ? AND last_missing_at >= ?",
    args: [did, cutoff],
  });
  return res.rows.length > 0;
}

/** Return every currently missing repo, newest first. */
export async function listMissingRepos(): Promise<MissingRepoRow[]> {
  const res = await db.execute({
    sql:
      "SELECT did, first_missing_at, last_missing_at, missing_count, last_error FROM missing_repos ORDER BY last_missing_at DESC",
    args: [],
  });
  return res.rows.map((r) => ({
    did: String(r[0]),
    first_missing_at: Number(r[1]),
    last_missing_at: Number(r[2]),
    missing_count: Number(r[3]),
    last_error: r[4] ? String(r[4]) : null,
  }));
}

/**
 * True when an error from listAll / fetchLiveRepo represents a canonical
 * RepoNotFound response from the PDS. Used by auto-enroll and drift-audit
 * to avoid treating transient errors as permanent deletions.
 */
export function isRepoNotFoundError(err: unknown): boolean {
  if (!(err instanceof ListRecordsError)) return false;
  if (err.status !== 400 && err.status !== 404) return false;
  return /repo(?:sitory)?notfound|could not find repo/i.test(err.detail);
}
