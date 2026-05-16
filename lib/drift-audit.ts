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

export interface DriftRow {
  did: string;
  pdsUrl: string | null;
  mirror: number;
  pds: number | null;
  pdsError: string | null;
}

export interface DriftAuditResult {
  rows: DriftRow[];
  recoverable: DriftRow[];
  ahead: DriftRow[];
  errors: DriftRow[];
}

const PDS_FETCH_TIMEOUT_MS = 15_000;
const PDS_LIST_PAGE_CAP = 200;

async function countPdsBookmarks(
  pdsUrl: string,
  did: string,
): Promise<number> {
  let total = 0;
  let cursor: string | undefined;
  for (let page = 0; page < PDS_LIST_PAGE_CAP; page++) {
    const url = new URL(`${pdsUrl}/xrpc/com.atproto.repo.listRecords`);
    url.searchParams.set("repo", did);
    url.searchParams.set("collection", "community.lexicon.bookmarks.bookmark");
    url.searchParams.set("limit", "100");
    if (cursor) url.searchParams.set("cursor", cursor);
    const res = await fetch(url.toString(), {
      signal: AbortSignal.timeout(PDS_FETCH_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`listRecords: ${res.status}`);
    const data = await res.json();
    const batch: unknown[] = data.records ?? [];
    total += batch.length;
    cursor = data.cursor;
    if (!cursor || batch.length === 0) break;
  }
  return total;
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
    if (pdsUrl) {
      try {
        pds = await countPdsBookmarks(pdsUrl, did);
      } catch (err) {
        pdsError = String(err);
      }
    } else {
      pdsError = "no pds_url";
    }

    const row: DriftRow = { did, pdsUrl, mirror, pds, pdsError };
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
