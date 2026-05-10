/**
 * Public marketing metrics — total user count for "join N others" copy.
 *
 * Source: distinct DIDs in user_settings. A row gets created the first
 * time getUserSettings() runs for a DID, which happens on every initial
 * data load post-login, so this counts everyone who has ever signed in
 * (active or not — that's the marketing-metric definition).
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
  const result = await db.execute({
    sql: "SELECT COUNT(*) FROM user_settings",
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
