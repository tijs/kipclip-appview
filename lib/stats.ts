/**
 * Public marketing metrics — total user count for "join N others" copy.
 *
 * Primary source: seen_dids ledger (lib/seen-dids.ts), upserted on
 * every authenticated /api/auth/session call. Persistent across
 * session expiry, so the count never drifts down. The bySource
 * breakdown is kept for diagnostics — useful for spotting drift
 * between data sources without shelling onto the box.
 *
 * Cached for 24h via the shared cached-fetch helper so the count is
 * reusable elsewhere on the site without per-request DB pressure.
 */

import { db } from "./db.ts";
import { type CachedFetcher, createCachedFetcher } from "./cached-fetch.ts";

const TTL_MS = 24 * 60 * 60 * 1000;

export interface SiteStats {
  /** Total distinct DIDs that have ever logged in. */
  userCount: number;
  /** Per-source DID counts (debug). Each is COUNT(DISTINCT did) on its
   *  table. Useful for spotting drift between data sources, e.g. if
   *  tracked_dids has fewer DIDs than iron_session_storage we know
   *  auto-enrollment is lagging. */
  bySource: {
    seen_dids: number;
    sessions: number;
    user_settings: number;
    tracked_dids: number;
    bookmarks: number;
    tags: number;
    annotations: number;
    preferences: number;
  };
}

function toNumber(raw: unknown): number {
  const n = typeof raw === "number"
    ? raw
    : typeof raw === "bigint"
    ? Number(raw)
    : Number(raw ?? 0);
  return Number.isFinite(n) ? n : 0;
}

async function countDistinct(sql: string): Promise<number> {
  const result = await db.execute({ sql, args: [] });
  return toNumber(result.rows?.[0]?.[0]);
}

async function fetchStats(): Promise<SiteStats> {
  const [
    seenDids,
    sessions,
    userSettings,
    trackedDids,
    bookmarks,
    tags,
    annotations,
    preferences,
  ] = await Promise.all([
    countDistinct("SELECT COUNT(*) FROM seen_dids"),
    countDistinct(
      `SELECT COUNT(*) FROM iron_session_storage WHERE key LIKE 'session:did:%'`,
    ),
    countDistinct("SELECT COUNT(DISTINCT did) FROM user_settings"),
    countDistinct("SELECT COUNT(DISTINCT did) FROM tracked_dids"),
    countDistinct("SELECT COUNT(DISTINCT did) FROM bookmarks"),
    countDistinct("SELECT COUNT(DISTINCT did) FROM tags"),
    countDistinct("SELECT COUNT(DISTINCT did) FROM annotations"),
    countDistinct("SELECT COUNT(DISTINCT did) FROM preferences"),
  ]);

  return {
    userCount: seenDids,
    bySource: {
      seen_dids: seenDids,
      sessions,
      user_settings: userSettings,
      tracked_dids: trackedDids,
      bookmarks,
      tags,
      annotations,
      preferences,
    },
  };
}

const EMPTY_STATS: SiteStats = {
  userCount: 0,
  bySource: {
    seen_dids: 0,
    sessions: 0,
    user_settings: 0,
    tracked_dids: 0,
    bookmarks: 0,
    tags: 0,
    annotations: 0,
    preferences: 0,
  },
};

const fetcher: CachedFetcher<SiteStats> = createCachedFetcher({
  ttlMs: TTL_MS,
  fetch: fetchStats,
  fallback: EMPTY_STATS,
  label: "stats",
});

export function getStats(): Promise<{ data: SiteStats; stale: boolean }> {
  return fetcher.get();
}

/** Test-only: drop cache. */
export function _resetStatsCache(): void {
  fetcher.reset();
}
