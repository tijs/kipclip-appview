/**
 * Persisted TAP-repo classification and quarantine bookkeeping.
 *
 * The weekly-drift problem: TAP keeps resync workers busy on repos that are
 * confirmed absent (RepoNotFound on the PLC-advertised PDS) or whose PDS is
 * merely unavailable (DNS/refused/timeout/5xx). The two are NOT the same:
 *
 *   - `missing`     — repo-level absence confirmed against a healthy PDS.
 *                    These are quarantine candidates: removing the TAP
 *                    enrollment stops the resync storm while tracked_dids,
 *                    mirror rows, and missing_repos evidence all remain.
 *   - `unavailable` — infrastructure uncertainty (DNS/refused/timeout/5xx).
 *                    Never a deletion decision. Persisted with a cooldown
 *                    and recheck schedule (`next_check_at`); the daily audit
 *                    re-probes only when due.
 *
 * Absence of a row means "healthy last known". `markRepoHealthy` clears the
 * state when a probe succeeds, which re-opens normal enrollment.
 *
 * This table NEVER holds the source of truth for tracked users (that is
 * `tracked_dids`) nor the missing-repo retention evidence (`missing_repos`);
 * it only classifies TAP-side sync posture. No function here deletes rows
 * from those tables.
 */

import { db } from "./db.ts";

export type TapRepoState = "missing" | "unavailable";

/** Cooldown before re-probing an unavailable PDS (24h). The daily audit is
 * the only kipclip-side prober; a daily cadence is the natural bound. */
export const UNAVAILABLE_PDS_COOLDOWN_MS = 24 * 60 * 60 * 1000;

export interface TapRepoStateRow {
  did: string;
  state: TapRepoState;
  firstSeenAt: number;
  lastCheckedAt: number;
  nextCheckAt: number;
  failureCount: number;
  lastErrorClass: string | null;
}

interface StateInsert {
  did: string;
  state: TapRepoState;
  errorClass?: string;
  error?: string;
  cooldownMs?: number;
}

async function upsertState(s: StateInsert): Promise<void> {
  const now = Date.now();
  const cooldown = s.cooldownMs ?? 0;
  await db.execute({
    sql: `
      INSERT INTO tap_repo_state
        (did, state, first_seen_at, last_checked_at, next_check_at,
         failure_count, last_error_class, last_error)
      VALUES (?, ?, ?, ?, ?, 1, ?, ?)
      ON CONFLICT(did) DO UPDATE SET
        state = CASE
          -- RepoNotFound evidence wins over a transient unavailable probe:
          -- a permanently absent repo must not be downgraded to infra
          -- uncertainty, and vice versa the cooldown must not be scheduled
          -- for a DID we already know is missing.
          WHEN excluded.state = 'missing' THEN 'missing'
          WHEN tap_repo_state.state = 'missing' THEN 'missing'
          ELSE excluded.state
        END,
        last_checked_at = excluded.last_checked_at,
        next_check_at = CASE
          WHEN tap_repo_state.state = 'missing' AND excluded.state = 'unavailable'
            THEN tap_repo_state.next_check_at
          ELSE excluded.next_check_at
        END,
        failure_count = CASE
          WHEN excluded.state = 'missing' AND tap_repo_state.state = 'missing'
            THEN tap_repo_state.failure_count + 1
          ELSE 1
        END,
        last_error_class = excluded.last_error_class,
        last_error = excluded.last_error
    `,
    args: [
      s.did,
      s.state,
      now,
      now,
      now + cooldown,
      s.errorClass ?? null,
      s.error ? boundedError(s.error) : null,
    ],
  });
}

/** Keep stored error text bounded — class + first line, never payloads. */
function boundedError(err: string): string {
  const line = err.split("\n")[0] ?? "";
  return line.length > 160 ? line.slice(0, 157) + "…" : line;
}

/** A repo was confirmed absent (RepoNotFound against a healthy PDS). */
export async function recordRepoMissing(
  did: string,
  errorClass = "reponotfound",
  error?: string,
): Promise<void> {
  await upsertState({ did, state: "missing", errorClass, error });
}

/** A PDS probe failed for infrastructure reasons; schedule a cooldown. */
export async function recordRepoUnavailable(
  did: string,
  errorClass = "unavailable",
  error?: string,
): Promise<void> {
  await upsertState({
    did,
    state: "unavailable",
    errorClass,
    error,
    cooldownMs: UNAVAILABLE_PDS_COOLDOWN_MS,
  });
}

/** A probe succeeded — the repo is healthy; drop the classification. */
export async function markRepoHealthy(did: string): Promise<void> {
  await db.execute({
    sql: "DELETE FROM tap_repo_state WHERE did = ?",
    args: [did],
  });
}

/** True while an unavailable PDS is inside its cooldown window. */
export async function isUnavailableInCooldown(did: string): Promise<boolean> {
  const now = Date.now();
  const res = await db.execute({
    sql:
      "SELECT 1 FROM tap_repo_state WHERE did = ? AND state = 'unavailable' AND next_check_at > ?",
    args: [did, now],
  });
  return res.rows.length > 0;
}

/** True when the repo is in the confirmed-missing state (quarantine target). */
export async function isRepoMissingState(did: string): Promise<boolean> {
  const res = await db.execute({
    sql: "SELECT 1 FROM tap_repo_state WHERE did = ? AND state = 'missing'",
    args: [did],
  });
  return res.rows.length > 0;
}

function rowsToState(
  rows: unknown[][],
): TapRepoStateRow[] {
  return rows.map((r) => ({
    did: String(r[0]),
    state: String(r[1]) as TapRepoState,
    firstSeenAt: Number(r[2]),
    lastCheckedAt: Number(r[3]),
    nextCheckAt: Number(r[4]),
    failureCount: Number(r[5]),
    lastErrorClass: r[6] ? String(r[6]) : null,
  }));
}

/**
 * Confirmed-missing repos that should be quarantined (removed from TAP
 * enrollment) so they stop occupying TAP resync workers. Restricted to
 * repos kipclip still TRACKS locally: their tracked_dids row, mirror data,
 * and missing_repos evidence remain untouched — quarantine only stops TAP
 * from burning workers on them. TAP-only repos (no tracked_dids row) are
 * deliberately NOT auto-quarantined here; that is an approval-gated
 * operator action (scripts/tap-only-cleanup.ts). Unavailable-PDS rows are
 * NEVER candidates — infra uncertainty is not deletion.
 */
export async function listQuarantineCandidates(): Promise<TapRepoStateRow[]> {
  const res = await db.execute({
    sql: `
      SELECT s.did, s.state, s.first_seen_at, s.last_checked_at,
             s.next_check_at, s.failure_count, s.last_error_class
      FROM tap_repo_state s
      WHERE s.state = 'missing'
        AND s.did IN (SELECT did FROM tracked_dids)
      ORDER BY s.first_seen_at ASC
    `,
    args: [],
  });
  return rowsToState(res.rows);
}

/** Unavailable PDS rows whose cooldown has expired — recheck probes due. */
export async function listUnavailableRecheckDue(): Promise<TapRepoStateRow[]> {
  const now = Date.now();
  const res = await db.execute({
    sql:
      "SELECT did, state, first_seen_at, last_checked_at, next_check_at, failure_count, last_error_class FROM tap_repo_state WHERE state = 'unavailable' AND next_check_at <= ? ORDER BY next_check_at ASC",
    args: [now],
  });
  return rowsToState(res.rows);
}

/** Every persisted classification (for operator dry-runs / reports). */
export async function listTapRepoStates(): Promise<TapRepoStateRow[]> {
  const res = await db.execute({
    sql:
      "SELECT did, state, first_seen_at, last_checked_at, next_check_at, failure_count, last_error_class FROM tap_repo_state ORDER BY last_checked_at DESC",
    args: [],
  });
  return rowsToState(res.rows);
}
