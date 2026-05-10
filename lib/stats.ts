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
  // Union across every DID-keyed source the appview maintains.
  //
  // - iron_session_storage stores OAuth sessions under keys shaped
  //   `session:did:plc:xxx`, so every successful sign-in shows up
  //   here even if the user never persisted anything else. This is
  //   the broadest signal of "tried kipclip" and the only one that
  //   captures users who sign in via /save (bookmarklet, share
  //   target) without ever reaching /api/initial-data.
  // - user_settings + tracked_dids capture users who hit the
  //   post-login hydration path.
  // - bookmarks/tags/annotations/preferences capture anyone who has
  //   actually persisted records (mirror tables).
  //
  // SELECT-UNION-without-ALL deduplicates, so the outer COUNT(*) is
  // the distinct-DID count across all sources. Runs at most once
  // per 24h thanks to the cached fetcher.
  const result = await db.execute({
    sql: `
      SELECT COUNT(*) FROM (
        SELECT substr(key, 9) AS did FROM iron_session_storage
          WHERE key LIKE 'session:did:%'
        UNION
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
