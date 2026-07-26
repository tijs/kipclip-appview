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
 */

import { db } from "./db.ts";
import { resolveDid } from "./plc-resolver.ts";
import { listAll } from "./mirror-sync.ts";
import {
  forgetMissingRepo,
  isMissingRepo,
  isRepoNotFoundError,
  MISSING_REPO_RECHECK_COOLDOWN_MS,
  recordMissingRepo,
} from "./missing-repo.ts";

export interface DriftRow {
  did: string;
  pdsUrl: string | null;
  mirror: number;
  pds: number | null;
  pdsError: string | null;
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
    let resolvedPdsUrl: string | null = pdsUrl;
    let migrated: { from: string; to: string } | undefined;

    if (pdsUrl) {
      try {
        if (await isMissingRepo(did, MISSING_REPO_RECHECK_COOLDOWN_MS)) {
          pdsError = "repo marked missing (cooldown)";
        } else {
          pds = await countPdsBookmarks(pdsUrl, did);
          await forgetMissingRepo(did);
        }
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
              migrated = { from: pdsUrl, to: resolved.pdsUrl };
              resolvedPdsUrl = resolved.pdsUrl;
              await db.execute({
                sql: "UPDATE tracked_dids SET pds_url = ? WHERE did = ?",
                args: [resolved.pdsUrl, did],
              });
            } catch (retryErr) {
              if (isRepoNotFoundError(retryErr)) {
                await recordMissingRepo(did, String(retryErr));
                pdsError = String(retryErr);
              } else {
                pdsError = `${firstErr}; retry: ${retryErr}`;
              }
            }
          } else if (isRepoNotFoundError(firstErr)) {
            await recordMissingRepo(did, String(firstErr));
            pdsError = String(firstErr);
          } else {
            // No migration detected — surface the original error.
            pdsError = String(firstErr);
          }
        } catch (retryErr) {
          pdsError = `${firstErr}; retry: ${retryErr}`;
        }
      }
    } else {
      pdsError = "no pds_url";
    }

    const row: DriftRow = {
      did,
      pdsUrl: resolvedPdsUrl,
      mirror,
      pds,
      pdsError,
      pdsMigrated: migrated,
    };
    rows.push(row);
    i++;
    onProgress?.(row, i, total);
  }

  const recoverable: DriftRow[] = [];
  const ahead: DriftRow[] = [];
  const errors: DriftRow[] = [];
  for (const row of rows) {
    if (row.pdsError) {
      errors.push(row);
      continue;
    }
    const diff = (row.pds ?? 0) - row.mirror;
    if (diff > 0) recoverable.push(row);
    else if (diff < 0) ahead.push(row);
  }

  return { rows, recoverable, ahead, errors };
}
