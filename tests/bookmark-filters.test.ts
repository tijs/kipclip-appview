/**
 * Tests for bookmark filtering logic.
 * Tests buildTagIndex, filterByTags, and matchesSearch as pure functions.
 */

import { assertEquals } from "@std/assert";
import {
  buildTagIndex,
  filterByTags,
  matchesSearch,
} from "../shared/bookmark-filters.ts";
import type { EnrichedBookmark } from "../shared/types.ts";

function makeBookmark(
  rkey: string,
  tags?: string[],
  extra?: Partial<EnrichedBookmark>,
): EnrichedBookmark {
  return {
    uri: `at://did:plc:test/community.lexicon.bookmarks.bookmark/${rkey}`,
    cid: `cid-${rkey}`,
    subject: `https://example.com/${rkey}`,
    createdAt: "2026-01-01T00:00:00.000Z",
    tags,
    ...extra,
  };
}

// ============================================================================
// buildTagIndex
// ============================================================================

Deno.test("buildTagIndex - creates lowercase tag sets", () => {
  const bookmarks = [
    makeBookmark("1", ["Swift", "iOS"]),
    makeBookmark("2", ["react", "WEB"]),
  ];
  const index = buildTagIndex(bookmarks);

  assertEquals(index.size, 2);
  assertEquals(
    index.get(bookmarks[0].uri),
    new Set(["swift", "ios"]),
  );
  assertEquals(
    index.get(bookmarks[1].uri),
    new Set(["react", "web"]),
  );
});

Deno.test("buildTagIndex - handles undefined tags", () => {
  const bookmarks = [makeBookmark("1", undefined)];
  const index = buildTagIndex(bookmarks);

  assertEquals(index.get(bookmarks[0].uri), new Set());
});

Deno.test("buildTagIndex - handles empty tags array", () => {
  const bookmarks = [makeBookmark("1", [])];
  const index = buildTagIndex(bookmarks);

  assertEquals(index.get(bookmarks[0].uri), new Set());
});

// ============================================================================
// filterByTags — single tag selection
// ============================================================================

Deno.test("filterByTags - returns matching bookmarks for single tag", () => {
  const bookmarks = [
    makeBookmark("1", ["swift", "ios"]),
    makeBookmark("2", ["react", "web"]),
    makeBookmark("3", ["swift", "web"]),
  ];
  const index = buildTagIndex(bookmarks);

  const result = filterByTags(bookmarks, new Set(["swift"]), index);
  assertEquals(result.length, 2);
  assertEquals(result[0].uri, bookmarks[0].uri);
  assertEquals(result[1].uri, bookmarks[2].uri);
});

Deno.test("filterByTags - case-insensitive matching", () => {
  const bookmarks = [
    makeBookmark("1", ["Swift"]),
    makeBookmark("2", ["SWIFT"]),
    makeBookmark("3", ["swift"]),
  ];
  const index = buildTagIndex(bookmarks);

  const result = filterByTags(bookmarks, new Set(["swift"]), index);
  assertEquals(result.length, 3);
});

Deno.test("filterByTags - tag value with different casing", () => {
  const bookmarks = [
    makeBookmark("1", ["2d", "art"]),
    makeBookmark("2", ["3d"]),
  ];
  const index = buildTagIndex(bookmarks);

  // Tag sidebar might pass "2d" or "2D" — both should work
  const result1 = filterByTags(bookmarks, new Set(["2d"]), index);
  assertEquals(result1.length, 1);
  assertEquals(result1[0].uri, bookmarks[0].uri);

  const result2 = filterByTags(bookmarks, new Set(["2D"]), index);
  assertEquals(result2.length, 1);
  assertEquals(result2[0].uri, bookmarks[0].uri);
});

Deno.test("filterByTags - returns empty when no bookmarks match", () => {
  const bookmarks = [
    makeBookmark("1", ["swift"]),
    makeBookmark("2", ["react"]),
  ];
  const index = buildTagIndex(bookmarks);

  const result = filterByTags(bookmarks, new Set(["python"]), index);
  assertEquals(result.length, 0);
});

// ============================================================================
// filterByTags — multiple tag selection (AND logic)
// ============================================================================

Deno.test("filterByTags - AND logic: all selected tags must be present", () => {
  const bookmarks = [
    makeBookmark("1", ["swift", "ios", "mobile"]),
    makeBookmark("2", ["swift", "macos"]),
    makeBookmark("3", ["react", "ios"]),
  ];
  const index = buildTagIndex(bookmarks);

  const result = filterByTags(
    bookmarks,
    new Set(["swift", "ios"]),
    index,
  );
  assertEquals(result.length, 1);
  assertEquals(result[0].uri, bookmarks[0].uri);
});

Deno.test("filterByTags - AND with case-insensitive tags", () => {
  const bookmarks = [
    makeBookmark("1", ["Swift", "iOS"]),
    makeBookmark("2", ["swift", "web"]),
  ];
  const index = buildTagIndex(bookmarks);

  const result = filterByTags(
    bookmarks,
    new Set(["SWIFT", "IOS"]),
    index,
  );
  assertEquals(result.length, 1);
  assertEquals(result[0].uri, bookmarks[0].uri);
});

// ============================================================================
// filterByTags — edge cases
// ============================================================================

Deno.test("filterByTags - no tags selected returns all bookmarks", () => {
  const bookmarks = [
    makeBookmark("1", ["swift"]),
    makeBookmark("2", ["react"]),
  ];
  const index = buildTagIndex(bookmarks);

  const result = filterByTags(bookmarks, new Set(), index);
  assertEquals(result.length, 2);
});

Deno.test("filterByTags - bookmarks with undefined tags are excluded", () => {
  const bookmarks = [
    makeBookmark("1", ["swift"]),
    makeBookmark("2", undefined),
    makeBookmark("3", []),
  ];
  const index = buildTagIndex(bookmarks);

  const result = filterByTags(bookmarks, new Set(["swift"]), index);
  assertEquals(result.length, 1);
  assertEquals(result[0].uri, bookmarks[0].uri);
});

Deno.test("filterByTags - empty bookmarks array returns empty", () => {
  const index = buildTagIndex([]);
  const result = filterByTags([], new Set(["swift"]), index);
  assertEquals(result.length, 0);
});

// ============================================================================
// matchesSearch
// ============================================================================

Deno.test("matchesSearch - matches title", () => {
  const bm = makeBookmark("1", [], { title: "Swift Programming" });
  assertEquals(matchesSearch(bm, "swift"), true);
  assertEquals(matchesSearch(bm, "SWIFT"), true);
  assertEquals(matchesSearch(bm, "python"), false);
});

Deno.test("matchesSearch - matches description", () => {
  const bm = makeBookmark("1", [], { description: "Learn React hooks" });
  assertEquals(matchesSearch(bm, "react"), true);
  assertEquals(matchesSearch(bm, "hooks"), true);
});

Deno.test("matchesSearch - matches subject URL", () => {
  const bm = makeBookmark("1", []);
  assertEquals(matchesSearch(bm, "example.com"), true);
});

Deno.test("matchesSearch - matches note", () => {
  const bm = makeBookmark("1", [], { note: "Great tutorial" });
  assertEquals(matchesSearch(bm, "tutorial"), true);
});

Deno.test("matchesSearch - matches tags", () => {
  const bm = makeBookmark("1", ["Swift", "iOS"]);
  assertEquals(matchesSearch(bm, "swift"), true);
  assertEquals(matchesSearch(bm, "ios"), true);
  assertEquals(matchesSearch(bm, "android"), false);
});

Deno.test("matchesSearch - handles bookmark with no optional fields", () => {
  const bm = makeBookmark("1", undefined);
  assertEquals(matchesSearch(bm, "test"), false);
  // Should not throw
  assertEquals(matchesSearch(bm, "example.com"), true); // matches subject
});
