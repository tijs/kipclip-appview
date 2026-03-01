/**
 * Cache-first data loading with progressive server fetch.
 * First page renders in ~1s, remaining pages load in background.
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
import { apiGet } from "../utils/api.ts";
import { perf } from "../perf.ts";

export interface CachedData {
  bookmarks: EnrichedBookmark[];
  tags: EnrichedTag[];
}

export interface SyncCallbacks {
  /** Called when the first page of data is ready */
  onFirstPage: (data: InitialDataResponse) => void;
  /** Called when a subsequent page of bookmarks arrives */
  onMoreBookmarks: (bookmarks: EnrichedBookmark[]) => void;
  /** Called when all pages are loaded */
  onComplete: (allBookmarks: EnrichedBookmark[]) => void;
}

export interface SyncResult {
  /** Data to render immediately (from cache) */
  immediate: CachedData | null;
  /** Promise that resolves when the first server page is loaded */
  firstPage: Promise<InitialDataResponse>;
}

/**
 * Load data with cache-first strategy.
 * Returns cached data immediately if available, plus a first-page promise.
 */
export async function loadWithCache(): Promise<SyncResult> {
  perf.start("cacheRead");
  const [cachedBookmarks, cachedTags] = await Promise.all([
    getCachedBookmarks(),
    getCachedTags(),
  ]);
  perf.end("cacheRead");

  const hasCache = cachedBookmarks !== null && cachedTags !== null;

  const firstPage = fetchFirstPage();

  return {
    immediate: hasCache
      ? { bookmarks: cachedBookmarks!, tags: cachedTags! }
      : null,
    firstPage,
  };
}

/**
 * Fetch the first page of data from the server.
 */
async function fetchFirstPage(): Promise<InitialDataResponse> {
  perf.start("firstPage");
  const response = await apiGet("/api/initial-data");
  if (!response.ok) {
    throw new Error("Failed to load initial data");
  }
  const data = await response.json();
  perf.end("firstPage");
  return data;
}

export interface LoadPagesResult {
  bookmarks: EnrichedBookmark[];
  /** True when all pages were loaded (cursor exhausted). False if a page failed. */
  complete: boolean;
}

/**
 * Progressively load remaining bookmark pages.
 * Returns the full array of all bookmarks (first page + remaining)
 * and whether loading completed fully.
 */
export async function loadRemainingPages(
  firstPageData: InitialDataResponse,
): Promise<LoadPagesResult> {
  perf.start("remainingPages");
  const allBookmarks = [...firstPageData.bookmarks];
  let bookmarkCursor = firstPageData.bookmarkCursor;
  let annotationCursor = firstPageData.annotationCursor;
  let complete = true;

  while (bookmarkCursor) {
    const params = new URLSearchParams();
    params.set("bookmarkCursor", bookmarkCursor);
    if (annotationCursor) params.set("annotationCursor", annotationCursor);

    const response = await apiGet(`/api/initial-data?${params}`);
    if (!response.ok) {
      complete = false;
      break;
    }

    const page = await response.json();
    if (page.bookmarks?.length > 0) {
      allBookmarks.push(...page.bookmarks);
    }

    bookmarkCursor = page.bookmarkCursor;
    annotationCursor = page.annotationCursor;
  }

  // Pages arrive in cursor order which may not match createdAt order.
  // Re-sort so newest bookmarks appear first after merging all pages.
  allBookmarks.sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  perf.end("remainingPages");
  return { bookmarks: allBookmarks, complete };
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

/** Fire-and-forget sync hash update */
export function updateSyncHash(): void {
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
  perf.start("cacheWrite");
  await Promise.all([
    putBookmarks(data.bookmarks),
    putTags(data.tags),
    setSyncMeta("lastSync", new Date().toISOString()),
  ]);
  perf.end("cacheWrite");
}

/**
 * Mark cache as stale (forces eager refresh on next load).
 */
export async function invalidateCache(): Promise<void> {
  await setSyncMeta("lastSyncHash", "");
}
