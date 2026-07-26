/**
 * Persistent tracking of repos confirmed missing (deleted/deactivated accounts
 * or defunct PDSs). Used by auto-enroll and drift-alert to back off retries and
 * eventually clean up tracking for DIDs that stay gone.
 */

import { db } from "./db.ts";

/** Re-check a missing repo only after this cooldown (7 days). */
export const MISSING_REPO_RECHECK_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;

/** Remove tracking for a repo that has been missing this long (60 days). */
export const MISSING_REPO_REMOVAL_THRESHOLD_MS = 60 * 24 * 60 * 60 * 1000;

export interface MissingRepoRow {
  did: string;
  first_missing_at: number;
  last_missing_at: number;
  missing_count: number;
  last_error: string | null;
}

/**
 * Record that a repo is confirmed missing. Preserves the first-seen timestamp
 * and bumps the counter. Call this only for clear RepoNotFound-style failures,
 * not transient network errors.
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
    args: [did, now, now, error ?? null],
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
 * DIDs that have been missing long enough to be removed from tracking.
 */
export async function listMissingReposForRemoval(
  thresholdMs: number,
): Promise<MissingRepoRow[]> {
  const cutoff = Date.now() - thresholdMs;
  const res = await db.execute({
    sql:
      "SELECT did, first_missing_at, last_missing_at, missing_count, last_error FROM missing_repos WHERE first_missing_at <= ? ORDER BY first_missing_at ASC",
    args: [cutoff],
  });
  return res.rows.map((r) => ({
    did: String(r[0]),
    first_missing_at: Number(r[1]),
    last_missing_at: Number(r[2]),
    missing_count: Number(r[3]),
    last_error: r[4] ? String(r[4]) : null,
  }));
}
