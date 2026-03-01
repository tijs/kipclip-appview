/**
 * Pure bookmark filtering functions.
 * Extracted from AppContext so they can be unit-tested without React.
 */

import type { EnrichedBookmark } from "./types.ts";

/**
 * Build a map of bookmark URI → lowercased tag Set.
 * Used for efficient tag filtering without re-normalizing on every filter.
 */
export function buildTagIndex(
  bookmarks: EnrichedBookmark[],
): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  for (const b of bookmarks) {
    const lowerTags = new Set(b.tags?.map((t) => t.toLowerCase()) ?? []);
    map.set(b.uri, lowerTags);
  }
  return map;
}

/**
 * Filter bookmarks by selected tags (case-insensitive, AND logic).
 * A bookmark must have ALL selected tags to be included.
 */
export function filterByTags(
  bookmarks: EnrichedBookmark[],
  selectedTags: Set<string>,
  tagIndex: Map<string, Set<string>>,
): EnrichedBookmark[] {
  if (selectedTags.size === 0) return bookmarks;

  const selectedLower = [...selectedTags].map((t) => t.toLowerCase());
  return bookmarks.filter((b) => {
    const tags = tagIndex.get(b.uri);
    return tags !== undefined && selectedLower.every((t) => tags.has(t));
  });
}

/**
 * Case-insensitive search across bookmark searchable fields.
 */
export function matchesSearch(
  bookmark: EnrichedBookmark,
  query: string,
): boolean {
  const q = query.toLowerCase();
  return (
    bookmark.title?.toLowerCase().includes(q) ||
    bookmark.description?.toLowerCase().includes(q) ||
    bookmark.subject.toLowerCase().includes(q) ||
    bookmark.note?.toLowerCase().includes(q) ||
    bookmark.tags?.some((tag) => tag.toLowerCase().includes(q)) ||
    false
  );
}
