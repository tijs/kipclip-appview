/**
 * Shared mirror-vs-PDS drift audit.
 *
 * For every row in `tracked_dids`, counts local mirror bookmarks vs
 * PDS `community.lexicon.bookmarks.bookmark` records (paginated). Used
 * by `scripts/audit-mirror.ts` (operator CLI) and
 * `scripts/drift-alert.ts` (systemd timer that emits Sentry alerts when
 * recoverable drift appears).
 *
 * Recovery candidates are rows where `pds > mirror` — the silent-401
 * bug pattern: PDS holds records the mirror never received because TAP
 * wasn't actually tracking the DID. `mirror > pds` is "ahead" and
 * usually means the mirror has stale rows for records the user deleted
 * on the PDS — non-recoverable, separate cleanup path.
 *
 * PDS failures are CLASSIFIED, never collapsed: every probed row gets a
 * `pdsErrorClass` (see lib/pds-error.ts) and the outcome is persisted to
 * `tap_repo_state` — `missing` for confirmed RepoNotFound (quarantine
 * candidate), `unavailable` with a cooldown for DNS/refused/timeout/5xx
 * (infrastructure uncertainty, never deletion). Rows inside a cooldown
 * (missing-repo recheck cooldown, unavailable-PDS cooldown) are reported
 * in a separate `skipped` partition instead of being probed again, so a
 * run never silently reports `checked=0` with unexplained errors.
 */

import { db } from "./db.ts";
import { resolveDid } from "./plc-resolver.ts";
import { listAll } from "./mirror-sync.ts";
import {
  classifyPdsError,
  errorSummary,
  type PdsErrorClass,
} from "./pds-error.ts";
import {
  forgetMissingRepo,
  isMissingRepo,
  isRepoNotFoundError,
  MISSING_REPO_RECHECK_COOLDOWN_MS,
  recordMissingRepo,
} from "./missing-repo.ts";
import {
  isUnavailableInCooldown,
  markRepoHealthy,
  recordRepoMissing,
  recordRepoUnavailable,
} from "./tap-repo-state.ts";

export type DriftErrorClass =
  | PdsErrorClass
  | "missing-cooldown"
  | "cooldown-unavailable"
  | "no-pds-url"
  | "resolve-failed";

export interface DriftRow {
  did: string;
  pdsUrl: string | null;
  mirror: number;
  pds: number | null;
  pdsError: string | null;
  /** Classification of `pdsError` — see lib/pds-error.ts + DriftErrorClass.
   * Set for every row with a non-null `pdsError`. */
  pdsErrorClass: DriftErrorClass | null;
  /** True when the PDS was intentionally NOT probed this run (cooldown /
   * known-missing recheck window). Reported separately from operational
   * errors so a run isn't misread as clean or as checked. */
  skipped: boolean;
  /** Set when the stored pds_url was stale and the audit re-resolved
   * the current PDS via PLC. The new URL is persisted to
   * `tracked_dids.pds_url` so subsequent audits + backfills hit the
   * right host. */
  pdsMigrated?: { from: string; to: string };
}

export interface DriftAuditResult {
  rows: DriftRow[];
  recoverable: DriftRow[];
  ahead: DriftRow[];
  errors: DriftRow[];
  /** Rows not probed this run (cooldown / known-missing / unavailable
   * cooldown) — distinct from operational errors. */
  skipped: DriftRow[];
}

const PDS_LIST_PAGE_CAP = 200;

async function countPdsBookmarks(pdsUrl: string, did: string): Promise<number> {
  const records = await listAll(
    pdsUrl,
    did,
    "community.lexicon.bookmarks.bookmark",
    PDS_LIST_PAGE_CAP,
  );
  return records.length;
}

/**
 * Classify a PDS failure, persist it to tap_repo_state, and return the
 * row-facing error text. RepoNotFound -> `missing` (quarantine candidate);
 * everything else -> `unavailable` with a cooldown. Never destructive.
 */
async function recordPdsFailure(
  did: string,
  err: unknown,
): Promise<void> {
  const cls = classifyPdsError(err);
  if (cls === "reponotfound") {
    await recordMissingRepo(did, String(err));
    await recordRepoMissing(did, cls, errorSummary(err));
  } else {
    await recordRepoUnavailable(did, cls, errorSummary(err));
  }
}

/**
 * Run the audit and return a partitioned result. `onProgress` is called
 * per DID so long-running CLI runs can stream status to stderr.
 */
export async function auditTrackedDrift(
  onProgress?: (row: DriftRow, index: number, total: number) => void,
): Promise<DriftAuditResult> {
  const tracked = await db.execute({
    sql: "SELECT did, pds_url FROM tracked_dids ORDER BY added_at ASC",
    args: [],
  });

  const rows: DriftRow[] = [];
  const total = tracked.rows.length;
  let i = 0;
  for (const r of tracked.rows) {
    const [did, pdsUrl] = r as [string, string | null];
    const mirrorRes = await db.execute({
      sql: "SELECT COUNT(*) FROM bookmarks WHERE did = ?",
      args: [did],
    });
    const mirror = Number(mirrorRes.rows[0]?.[0] ?? 0);

    let pds: number | null = null;
    let pdsError: string | null = null;
    let pdsErrorClass: DriftErrorClass | null = null;
    let skipped = false;
    let resolvedPdsUrl: string | null = pdsUrl;
    let migrated: { from: string; to: string } | undefined;

    if (pdsUrl) {
      if (await isMissingRepo(did, MISSING_REPO_RECHECK_COOLDOWN_MS)) {
        // Known missing, within recheck cooldown — reported as skipped, not
        // probed, and not an operational error.
        pdsError = "repo marked missing (cooldown)";
        pdsErrorClass = "missing-cooldown";
        skipped = true;
      } else if (await isUnavailableInCooldown(did)) {
        // PDS unreachable on the last probe; skip until next_check_at.
        pdsError = "PDS unavailable (cooldown; recheck scheduled)";
        pdsErrorClass = "cooldown-unavailable";
        skipped = true;
      } else {
        try {
          pds = await countPdsBookmarks(pdsUrl, did);
          await forgetMissingRepo(did);
          await markRepoHealthy(did);
        } catch (firstErr) {
          // PDS unreachable or rejected the request. The most common
          // recoverable cause is that the user migrated their PDS after
          // first enrollment, leaving a stale URL in tracked_dids. Try
          // resolving the current PDS via PLC and retry once. If the
          // resolved URL differs, persist it so subsequent audits +
          // backfills hit the right host. Only mark the repo missing if
          // the current PDS also reports RepoNotFound.
          try {
            const resolved = await resolveDid(did);
            if (resolved && resolved.pdsUrl !== pdsUrl) {
              try {
                pds = await countPdsBookmarks(resolved.pdsUrl, did);
                await forgetMissingRepo(did);
                await markRepoHealthy(did);
                migrated = { from: pdsUrl, to: resolved.pdsUrl };
                resolvedPdsUrl = resolved.pdsUrl;
                await db.execute({
                  sql: "UPDATE tracked_dids SET pds_url = ? WHERE did = ?",
                  args: [resolved.pdsUrl, did],
                });
              } catch (retryErr) {
                await recordPdsFailure(did, retryErr);
                pdsError = isRepoNotFoundError(retryErr)
                  ? errorSummary(retryErr)
                  : `${errorSummary(firstErr)}; retry: ${
                    errorSummary(retryErr)
                  }`;
                pdsErrorClass = classifyPdsError(retryErr);
              }
            } else if (isRepoNotFoundError(firstErr)) {
              await recordPdsFailure(did, firstErr);
              pdsError = errorSummary(firstErr);
              pdsErrorClass = "reponotfound";
            } else {
              // No migration detected — surface the original error and
              // persist the classification (unavailable w/ cooldown).
              await recordPdsFailure(did, firstErr);
              pdsError = errorSummary(firstErr);
              pdsErrorClass = classifyPdsError(firstErr);
            }
          } catch (retryErr) {
            // resolveDid itself failed (PLC unreachable etc.) — the PDS
            // error stands; classify the probe failure, not the resolver.
            await recordPdsFailure(did, firstErr);
            pdsError = `${errorSummary(firstErr)}; retry: ${
              errorSummary(retryErr)
            }`;
            pdsErrorClass = classifyPdsError(firstErr);
          }
        }
      }
    } else {
      pdsError = "no pds_url";
      pdsErrorClass = "no-pds-url";
    }

    const row: DriftRow = {
      did,
      pdsUrl: resolvedPdsUrl,
      mirror,
      pds,
      pdsError,
      pdsErrorClass,
      skipped,
      pdsMigrated: migrated,
    };
    rows.push(row);
    i++;
    onProgress?.(row, i, total);
  }

  const recoverable: DriftRow[] = [];
  const ahead: DriftRow[] = [];
  const errors: DriftRow[] = [];
  const skipped: DriftRow[] = [];
  for (const row of rows) {
    if (row.pdsError) {
      if (row.skipped) skipped.push(row);
      else errors.push(row);
      continue;
    }
    const diff = (row.pds ?? 0) - row.mirror;
    if (diff > 0) recoverable.push(row);
    else if (diff < 0) ahead.push(row);
  }

  return { rows, recoverable, ahead, errors, skipped };
}
