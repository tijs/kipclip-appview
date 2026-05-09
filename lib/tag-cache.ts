/**
 * In-process tag cache for the PDS fallback path.
 *
 * Tracked (mirror) users bypass this — they read from local SQLite directly.
 * TTL of 60s matches the tab-refocus debounce on the frontend.
 *
 * Single-process cache: each server instance has its own Map. Invalidation is
 * per-DID on any tag mutation in the same process; TAP delivers convergence
 * across restarts and any multi-instance scenario.
 */

import type { EnrichedTag } from "../shared/types.ts";

interface TagCacheEntry {
  tags: EnrichedTag[];
  fetchedAt: number;
}

export const TAG_CACHE_TTL_MS = 60_000;

const tagCache = new Map<string, TagCacheEntry>();

export function getCachedTags(did: string): EnrichedTag[] | null {
  const entry = tagCache.get(did);
  if (!entry) return null;
  if (Date.now() - entry.fetchedAt > TAG_CACHE_TTL_MS) {
    tagCache.delete(did);
    return null;
  }
  return [...entry.tags];
}

export function setCachedTags(did: string, tags: EnrichedTag[]): void {
  tagCache.set(did, { tags, fetchedAt: Date.now() });
}

export function invalidateCachedTags(did: string): void {
  tagCache.delete(did);
}

/** @internal Test cleanup only */
export function _clearTagCache(): void {
  tagCache.clear();
}
