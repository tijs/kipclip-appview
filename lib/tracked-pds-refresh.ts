/**
 * Opportunistic refresh of `tracked_dids.pds_url` from the active OAuth
 * session's PDS endpoint.
 *
 * AT Protocol users can migrate their repo between PDSes. When they do,
 * the OAuth session reflects the new PDS immediately on next sign-in,
 * but `tracked_dids.pds_url` (set at enrollment time) stays pinned to
 * the old host until something updates it. Stale rows break audit +
 * backfill paths that hit the PDS by URL.
 *
 * Called from `getSessionFromRequest` after the OAuth session is
 * restored. Cheap: a single indexed UPDATE keyed by DID that only
 * touches rows where the URL actually changed. Fire-and-forget — never
 * blocks the request, never throws into the session path.
 *
 * Cache keeps the same DID from issuing a DB UPDATE on every request
 * once we've already verified the row is in sync. Cleared by a process
 * restart, which is fine because pds_url drift is rare and any stale
 * tracked_dids row will get caught by the daily drift-alert anyway.
 */

import { db } from "./db.ts";
import { captureMessage } from "./sentry.ts";

// Per-DID positive cache: DID -> last pdsUrl we know matches tracked_dids.
// On match: no DB write.
const inSyncCache = new Map<string, string>();

export function refreshTrackedPdsUrl(did: string, pdsUrl: string): void {
  if (!did || !pdsUrl) return;
  if (inSyncCache.get(did) === pdsUrl) return;

  void (async () => {
    try {
      // Only update when a row exists AND the URL actually differs.
      // Filtering in SQL avoids a write per request for the common
      // case of an unchanged URL.
      await db.execute({
        sql:
          "UPDATE tracked_dids SET pds_url = ? WHERE did = ? AND (pds_url IS NULL OR pds_url != ?)",
        args: [pdsUrl, did, pdsUrl],
      });
      inSyncCache.set(did, pdsUrl);
    } catch (err) {
      captureMessage("tracked_dids pds_url refresh failed", "warning", {
        did,
        pdsUrl,
        error: String(err),
      });
    }
  })();
}

/** Test-only — clear the in-sync cache between cases. */
export function _resetTrackedPdsCache(): void {
  inSyncCache.clear();
}
