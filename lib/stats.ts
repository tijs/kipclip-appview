/**
 * Public marketing metrics — total user count for "join N others" copy.
 *
 * Source: distinct DIDs across user_settings ∪ tracked_dids. user_settings
 * gets a row the first time getUserSettings() runs (initial data load
 * post-login). tracked_dids gets a row when auto-enrollment kicks in on
 * first sign-in. Either is usually enough on its own, but the union
 * catches edge cases (e.g. users who sign in but bail before
 * /api/initial-data hydrates) so the marketing count never undercounts
 * "people who have ever tried it".
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
}

async function fetchStats(): Promise<SiteStats> {
  // Union across every DID-keyed table the appview maintains.
  // user_settings + tracked_dids only catch users who reached the
  // post-login data hydration path; many users sign in via /save
  // (bookmarklet, share target) and never hit /api/initial-data, so
  // their DIDs only show up in bookmarks/tags/annotations/preferences.
  // SELECT-UNION-without-ALL deduplicates, so the outer COUNT(*) is
  // the distinct-DID count across the union. Runs at most once per
  // 24h thanks to the cached fetcher; the per-table SELECT did scans
  // are small even on a large mirror because they only project one
  // column and feed a hash-based UNION.
  const result = await db.execute({
    sql: `
      SELECT COUNT(*) FROM (
        SELECT did FROM user_settings
        UNION
        SELECT did FROM tracked_dids
        UNION
        SELECT did FROM bookmarks
        UNION
        SELECT did FROM tags
        UNION
        SELECT did FROM annotations
        UNION
        SELECT did FROM preferences
      )
    `,
    args: [],
  });
  // db.execute returns rows as unknown[][] — first column of first row
  // is our COUNT(*) value.
  const raw = result.rows?.[0]?.[0];
  const userCount = typeof raw === "number"
    ? raw
    : typeof raw === "bigint"
    ? Number(raw)
    : Number(raw ?? 0);
  return { userCount: Number.isFinite(userCount) ? userCount : 0 };
}

const fetcher: CachedFetcher<SiteStats> = createCachedFetcher({
  ttlMs: TTL_MS,
  fetch: fetchStats,
  fallback: { userCount: 0 },
  label: "stats",
});

export function getStats(): Promise<{ data: SiteStats; stale: boolean }> {
  return fetcher.get();
}

/** Test-only: drop cache. */
export function _resetStatsCache(): void {
  fetcher.reset();
}
