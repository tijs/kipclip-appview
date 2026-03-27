/**
 * Server data fetching and background pagination.
 * Used by AppContext for initial load, tab-focus sync, and manual refresh.
 */

import type {
  EnrichedBookmark,
  EnrichedTag,
  InitialDataResponse,
} from "../../shared/types.ts";
import { putBookmarks, putTags } from "./db.ts";
import { apiGet } from "../utils/api.ts";
import { perf } from "../perf.ts";

interface CachedData {
  bookmarks: EnrichedBookmark[];
  tags: EnrichedTag[];
}

interface LoadPagesResult {
  bookmarks: EnrichedBookmark[];
  /** True when all pages were loaded (cursor exhausted). False if a page failed. */
  complete: boolean;
}

/**
 * Progressively load remaining bookmark pages after the first page.
 * Returns the full array of all bookmarks (first page + remaining)
 * and whether loading completed fully.
 *
 * Respects PDS rate limits: pauses when remaining calls drop below 50.
 */
export async function loadRemainingPages(
  firstPageData: InitialDataResponse,
): Promise<LoadPagesResult> {
  perf.start("remainingPages");
  const allBookmarks = [...firstPageData.bookmarks];
  let bookmarkCursor = firstPageData.bookmarkCursor;
  let annotationCursor = firstPageData.annotationCursor;
  let complete = true;

  let currentRateLimit = firstPageData.rateLimit;

  while (bookmarkCursor) {
    // Respect PDS rate limits: if remaining is low, wait until reset
    if (currentRateLimit && currentRateLimit.remaining < 50) {
      const waitMs = Math.max(0, currentRateLimit.reset * 1000 - Date.now()) +
        500;
      console.warn("PDS rate limit low, pausing sync", {
        remaining: currentRateLimit.remaining,
        waitMs,
      });
      await new Promise((r) => setTimeout(r, waitMs));
    }

    const params = new URLSearchParams();
    params.set("bookmarkCursor", bookmarkCursor);
    if (annotationCursor) params.set("annotationCursor", annotationCursor);

    const response = await apiGet(`/api/initial-data?${params}`);
    if (!response.ok) {
      console.warn(
        `Page fetch failed: ${response.status}`,
        await response.text().catch(() => ""),
      );
      complete = false;
      break;
    }

    const page = await response.json();

    if (page.rateLimit) {
      currentRateLimit = page.rateLimit;
    }

    if (page.bookmarks?.length > 0) {
      allBookmarks.push(...page.bookmarks);
    }

    bookmarkCursor = page.bookmarkCursor;
    annotationCursor = page.annotationCursor;
  }

  // Re-sort so newest bookmarks appear first after merging all pages.
  allBookmarks.sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  perf.end("remainingPages");
  return { bookmarks: allBookmarks, complete };
}

/** Fetch the first page of data from the server. */
export async function fetchFirstPage(): Promise<InitialDataResponse> {
  perf.start("firstPage");
  const response = await apiGet("/api/initial-data");
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `Failed to load initial data: ${response.status} ${body}`,
    );
  }
  const data = await response.json();
  perf.end("firstPage");
  return data;
}

/** Persist bookmarks + tags to IndexedDB cache (clear-and-replace). */
export async function writeToCache(data: CachedData): Promise<void> {
  perf.start("cacheWrite");
  await Promise.all([
    putBookmarks(data.bookmarks),
    putTags(data.tags),
  ]);
  perf.end("cacheWrite");
}
