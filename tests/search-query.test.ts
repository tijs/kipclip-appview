/**
 * Tests for search query parsing with tag: syntax.
 */

import { assertEquals } from "@std/assert";
import { parseSearchQuery, toggleTagInQuery } from "../shared/search-query.ts";

// ============================================================================
// parseSearchQuery
// ============================================================================

Deno.test("parseSearchQuery - empty string", () => {
  const result = parseSearchQuery("");
  assertEquals(result, { tags: [], text: "" });
});

Deno.test("parseSearchQuery - plain text only", () => {
  const result = parseSearchQuery("hello world");
  assertEquals(result, { tags: [], text: "hello world" });
});

Deno.test("parseSearchQuery - single tag", () => {
  const result = parseSearchQuery("tag:swift");
  assertEquals(result, { tags: ["swift"], text: "" });
});

Deno.test("parseSearchQuery - multiple tags", () => {
  const result = parseSearchQuery("tag:swift tag:ios");
  assertEquals(result, { tags: ["swift", "ios"], text: "" });
});

Deno.test("parseSearchQuery - mixed tags and text", () => {
  const result = parseSearchQuery("tag:swift tutorials");
  assertEquals(result, { tags: ["swift"], text: "tutorials" });
});

Deno.test("parseSearchQuery - case-insensitive prefix", () => {
  const result = parseSearchQuery("TAG:Swift");
  assertEquals(result, { tags: ["swift"], text: "" });
});

Deno.test("parseSearchQuery - deduplicates tags", () => {
  const result = parseSearchQuery("tag:swift tag:SWIFT");
  assertEquals(result, { tags: ["swift"], text: "" });
});

Deno.test("parseSearchQuery - tag: with no value is literal text", () => {
  const result = parseSearchQuery("tag:");
  assertEquals(result, { tags: [], text: "tag:" });
});

Deno.test("parseSearchQuery - quoted tag with spaces", () => {
  const result = parseSearchQuery('tag:"animated short"');
  assertEquals(result, { tags: ["animated short"], text: "" });
});

Deno.test("parseSearchQuery - known unquoted tag with spaces", () => {
  const result = parseSearchQuery("tag:Animated Short", ["Animated Short"]);
  assertEquals(result, { tags: ["animated short"], text: "" });
});

Deno.test("parseSearchQuery - unknown unquoted words stay free text", () => {
  const result = parseSearchQuery("tag:swift tutorials", ["swift"]);
  assertEquals(result, { tags: ["swift"], text: "tutorials" });
});

Deno.test("parseSearchQuery - tags interspersed with text", () => {
  const result = parseSearchQuery("how to tag:swift learn tag:ios today");
  assertEquals(result, { tags: ["swift", "ios"], text: "how to learn today" });
});

// ============================================================================
// toggleTagInQuery
// ============================================================================

Deno.test("toggleTagInQuery - add to empty query", () => {
  assertEquals(toggleTagInQuery("", "swift"), "tag:swift");
});

Deno.test("toggleTagInQuery - add to existing text (prepend)", () => {
  assertEquals(toggleTagInQuery("tutorials", "swift"), "tag:swift tutorials");
});

Deno.test("toggleTagInQuery - quote tag with spaces", () => {
  assertEquals(toggleTagInQuery("", "Animated Short"), 'tag:"animated short"');
});

Deno.test("toggleTagInQuery - sidebar click round-trips tag with spaces", () => {
  const query = toggleTagInQuery("", "Animated Short");
  const parsed = parseSearchQuery(query, ["Animated Short"]);
  assertEquals(parsed, { tags: ["animated short"], text: "" });
});

Deno.test("toggleTagInQuery - remove quoted tag with spaces", () => {
  assertEquals(
    toggleTagInQuery('tag:"animated short" tutorials', "Animated Short"),
    "tutorials",
  );
});

Deno.test("toggleTagInQuery - remove known unquoted tag with spaces", () => {
  assertEquals(
    toggleTagInQuery("tag:Animated Short tutorials", "Animated Short"),
    "tutorials",
  );
});

Deno.test("toggleTagInQuery - known single-word tag does not consume text", () => {
  assertEquals(
    toggleTagInQuery("tag:swift tutorials", "swift", ["swift"]),
    "tutorials",
  );
});

Deno.test("toggleTagInQuery - remove existing tag", () => {
  assertEquals(toggleTagInQuery("tag:swift tutorials", "swift"), "tutorials");
});

Deno.test("toggleTagInQuery - case-insensitive removal", () => {
  assertEquals(toggleTagInQuery("tag:swift tutorials", "Swift"), "tutorials");
});

Deno.test("toggleTagInQuery - remove only matching tag, preserve others", () => {
  assertEquals(
    toggleTagInQuery("tag:swift tag:ios tutorials", "swift"),
    "tag:ios tutorials",
  );
});
