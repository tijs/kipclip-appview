/**
 * Server data fetching and background pagination.
 * Used by AppContext for initial load, tab-focus sync, and manual refresh.
 */

import type {
  EnrichedBookmark,
  EnrichedTag,
  InitialDataResponse,
  ListTagsResponse,
} from "../../shared/types.ts";
import { putBookmarks, putTags } from "./db.ts";
import { apiGet } from "../utils/api.ts";
import { perf } from "../perf.ts";

interface CachedData {
  bookmarks: EnrichedBookmark[];
  tags: EnrichedTag[];
}

/**
 * Fetch the user's full tag list from /api/tags.
 *
 * Fail-soft: returns [] on any network or non-OK response. Tags are split
 * out of /api/initial-data so the largest payload does not block first-paint;
 * clients fire this in parallel with fetchFirstPage via Promise.all, which
 * has fail-fast semantics. Returning [] instead of throwing keeps a transient
 * tag-fetch failure from blocking the bookmark render path.
 *
 * Callers that need strict error semantics should fetch /api/tags directly.
 */
export async function fetchTags(): Promise<EnrichedTag[]> {
  perf.start("tagsFetch");
  try {
    const response = await apiGet("/api/tags");
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      console.warn(`fetchTags: ${response.status} ${body}`);
      return [];
    }
    const data = (await response.json()) as ListTagsResponse;
    return data.tags ?? [];
  } catch (err) {
    console.warn("fetchTags: network error", err);
    return [];
  } finally {
    perf.end("tagsFetch");
  }
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
 * Optional onProgress callback reports page numbers as they load.
 */
export async function loadRemainingPages(
  firstPageData: InitialDataResponse,
  onProgress?: (page: number) => void,
): Promise<LoadPagesResult> {
  perf.start("remainingPages");
  const allBookmarks = [...firstPageData.bookmarks];
  let bookmarkCursor = firstPageData.bookmarkCursor;
  let annotationCursor = firstPageData.annotationCursor;
  let complete = true;
  let pageNumber = 1; // First page already loaded

  let currentRateLimit = firstPageData.rateLimit;

  while (bookmarkCursor) {
    pageNumber++;
    onProgress?.(pageNumber);

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

/**
 * Fetch the first page of data from the server.
 * When newestFirst is true, the API returns the newest bookmarks (by TID rkey)
 * on page 1. Use this for first-page diff checks. For full loads that will
 * paginate through all records, use newestFirst=false (default).
 */
export async function fetchFirstPage(
  options?: { newestFirst?: boolean },
): Promise<InitialDataResponse> {
  perf.start("firstPage");
  const params = options?.newestFirst ? "?newestFirst=true" : "";
  const response = await apiGet(`/api/initial-data${params}`);
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
