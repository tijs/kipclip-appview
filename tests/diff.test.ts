/**
 * Tests for first-page diff logic.
 * Tests diffFirstPage and buildCidMap as pure functions.
 */

import { assertEquals } from "@std/assert";
import { buildCidMap, diffFirstPage } from "../frontend/cache/diff.ts";
import type { EnrichedBookmark } from "../shared/types.ts";

function makeBookmark(
  rkey: string,
  cid?: string,
): EnrichedBookmark {
  return {
    uri: `at://did:plc:test/community.lexicon.bookmarks.bookmark/${rkey}`,
    cid: cid ?? `cid-${rkey}`,
    subject: `https://example.com/${rkey}`,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

// ============================================================================
// buildCidMap

Deno.test("buildCidMap creates URI→CID map", () => {
  const bookmarks = [makeBookmark("a"), makeBookmark("b")];
  const map = buildCidMap(bookmarks);
  assertEquals(map.size, 2);
  assertEquals(map.get(bookmarks[0].uri), "cid-a");
  assertEquals(map.get(bookmarks[1].uri), "cid-b");
});

Deno.test("buildCidMap handles empty array", () => {
  assertEquals(buildCidMap([]).size, 0);
});

// ============================================================================
// diffFirstPage: additions

Deno.test("diffFirstPage detects additions (new URIs)", () => {
  const cached = buildCidMap([makeBookmark("a"), makeBookmark("b")]);
  const server = [makeBookmark("a"), makeBookmark("b"), makeBookmark("c")];

  const result = diffFirstPage(server, cached);
  assertEquals(result.additions.length, 1);
  assertEquals(result.additions[0].uri, server[2].uri);
  assertEquals(result.updates.length, 0);
});

Deno.test("diffFirstPage detects multiple additions", () => {
  const cached = buildCidMap([makeBookmark("a")]);
  const server = [makeBookmark("a"), makeBookmark("b"), makeBookmark("c")];

  const result = diffFirstPage(server, cached);
  assertEquals(result.additions.length, 2);
});

// ============================================================================
// diffFirstPage: updates (edits)

Deno.test("diffFirstPage detects edits (same URI, different CID)", () => {
  const cached = buildCidMap([makeBookmark("a"), makeBookmark("b")]);
  const server = [makeBookmark("a"), makeBookmark("b", "new-cid-b")];

  const result = diffFirstPage(server, cached);
  assertEquals(result.additions.length, 0);
  assertEquals(result.updates.length, 1);
  assertEquals(result.updates[0].cid, "new-cid-b");
});

// ============================================================================
// diffFirstPage: no changes

Deno.test("diffFirstPage returns empty when nothing changed", () => {
  const bookmarks = [makeBookmark("a"), makeBookmark("b")];
  const cached = buildCidMap(bookmarks);

  const result = diffFirstPage(bookmarks, cached);
  assertEquals(result.additions.length, 0);
  assertEquals(result.updates.length, 0);
});

// ============================================================================
// diffFirstPage: mixed additions + edits

Deno.test("diffFirstPage handles additions and edits together", () => {
  const cached = buildCidMap([makeBookmark("a"), makeBookmark("b")]);
  const server = [
    makeBookmark("a", "new-cid-a"), // edit
    makeBookmark("b"), // unchanged
    makeBookmark("c"), // addition
  ];

  const result = diffFirstPage(server, cached);
  assertEquals(result.additions.length, 1);
  assertEquals(result.updates.length, 1);
  assertEquals(result.additions[0].uri, server[2].uri);
  assertEquals(result.updates[0].uri, server[0].uri);
});

// ============================================================================
// diffFirstPage: empty cache (cold start — all are additions)

Deno.test("diffFirstPage treats all as additions when cache is empty", () => {
  const cached = buildCidMap([]);
  const server = [makeBookmark("a"), makeBookmark("b"), makeBookmark("c")];

  const result = diffFirstPage(server, cached);
  assertEquals(result.additions.length, 3);
  assertEquals(result.updates.length, 0);
});

// ============================================================================
// diffFirstPage: empty server response

Deno.test("diffFirstPage returns empty when server has no bookmarks", () => {
  const cached = buildCidMap([makeBookmark("a"), makeBookmark("b")]);

  const result = diffFirstPage([], cached);
  assertEquals(result.additions.length, 0);
  assertEquals(result.updates.length, 0);
});

// ============================================================================
// diffFirstPage: bulk additions (all server records are new)

Deno.test("diffFirstPage handles bulk additions (entirely new first page)", () => {
  const cached = buildCidMap([makeBookmark("old-1"), makeBookmark("old-2")]);
  // Server returns 100 new records, none matching cache
  const server = Array.from({ length: 100 }, (_, i) =>
    makeBookmark(`new-${i}`)
  );

  const result = diffFirstPage(server, cached);
  assertEquals(result.additions.length, 100);
  assertEquals(result.updates.length, 0);
});

// ============================================================================
// diffFirstPage: missing records are ignored (not treated as deletions)

Deno.test("diffFirstPage ignores cached records missing from server", () => {
  // Cache has a, b, c — server only returns a, b (c was pushed off page 1)
  const cached = buildCidMap([
    makeBookmark("a"),
    makeBookmark("b"),
    makeBookmark("c"),
  ]);
  const server = [makeBookmark("a"), makeBookmark("b")];

  const result = diffFirstPage(server, cached);
  assertEquals(result.additions.length, 0);
  assertEquals(result.updates.length, 0);
  // "c" is simply not mentioned — it stays in cache as-is
});
