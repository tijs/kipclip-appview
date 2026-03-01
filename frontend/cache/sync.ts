/**
 * Cache-first data loading with background refresh.
 * On load: serve from IndexedDB immediately if available,
 * then refresh from server in background.
 */

import type {
  EnrichedBookmark,
  EnrichedTag,
  InitialDataResponse,
} from "../../shared/types.ts";
import {
  getCachedBookmarks,
  getCachedTags,
  getSyncMeta,
  putBookmarks,
  putTags,
  setSyncMeta,
} from "./db.ts";
import { diffRecords } from "./diff.ts";
import { apiGet } from "../utils/api.ts";

export interface CachedData {
  bookmarks: EnrichedBookmark[];
  tags: EnrichedTag[];
}

export interface SyncResult {
  /** Data to render immediately (from cache or network) */
  immediate: CachedData | null;
  /** Promise that resolves with full server data when background refresh completes */
  refresh: Promise<InitialDataResponse & { _unchanged?: boolean }>;
}

/**
 * Load data with cache-first strategy.
 * Returns cached data immediately if available, plus a refresh promise.
 */
export async function loadWithCache(): Promise<SyncResult> {
  const [cachedBookmarks, cachedTags] = await Promise.all([
    getCachedBookmarks(),
    getCachedTags(),
  ]);

  const hasCache = cachedBookmarks !== null && cachedTags !== null;

  const refresh = fetchAndSync(
    hasCache ? cachedBookmarks : null,
    hasCache ? cachedTags : null,
  );

  return {
    immediate: hasCache
      ? { bookmarks: cachedBookmarks!, tags: cachedTags! }
      : null,
    refresh,
  };
}

/**
 * Lightweight check using sync-check endpoint.
 * Returns true if data has changed since last sync hash.
 */
export async function checkForChanges(): Promise<boolean> {
  try {
    const lastHash = await getSyncMeta("lastSyncHash");
    if (!lastHash) return true;

    const response = await apiGet("/api/sync-check");
    if (!response.ok) return true;

    const { hash } = await response.json();
    return hash !== lastHash;
  } catch {
    return true;
  }
}

/**
 * Fetch fresh data from server.
 * Uses CID diffing to determine if React state update is needed.
 */
async function fetchAndSync(
  cachedBookmarks: EnrichedBookmark[] | null,
  cachedTags: EnrichedTag[] | null,
): Promise<InitialDataResponse & { _unchanged?: boolean }> {
  const response = await apiGet("/api/initial-data");
  if (!response.ok) {
    throw new Error("Failed to load initial data");
  }

  const data: InitialDataResponse = await response.json();

  // Write fresh data to cache + update sync hash
  await writeToCache({ bookmarks: data.bookmarks, tags: data.tags });
  updateSyncHash();

  // If we had cached data, check if anything actually changed
  if (cachedBookmarks && cachedTags) {
    const bookmarkDiff = diffRecords(cachedBookmarks, data.bookmarks);
    const tagDiff = diffRecords(cachedTags, data.tags);
    if (bookmarkDiff.isEmpty && tagDiff.isEmpty) {
      return { ...data, _unchanged: true };
    }
  }

  return data;
}

/** Fire-and-forget sync hash update */
function updateSyncHash(): void {
  apiGet("/api/sync-check").then(async (res) => {
    if (res.ok) {
      const { hash } = await res.json();
      await setSyncMeta("lastSyncHash", hash);
    }
  }).catch(() => {});
}

/**
 * Persist bookmarks + tags to IndexedDB cache.
 */
export async function writeToCache(data: CachedData): Promise<void> {
  await Promise.all([
    putBookmarks(data.bookmarks),
    putTags(data.tags),
    setSyncMeta("lastSync", new Date().toISOString()),
  ]);
}

/**
 * Mark cache as stale (forces eager refresh on next load).
 */
export async function invalidateCache(): Promise<void> {
  await setSyncMeta("lastSyncHash", "");
}
