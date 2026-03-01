import { assertEquals } from "@std/assert";
import {
  deduplicateTagsCaseInsensitive,
  findExistingTag,
  resolveTagCasing,
  tagIncludes,
  tagsEqual,
} from "../shared/tag-utils.ts";

// tagsEqual
Deno.test("tagsEqual - same case", () => {
  assertEquals(tagsEqual("Swift", "Swift"), true);
});

Deno.test("tagsEqual - different case", () => {
  assertEquals(tagsEqual("Swift", "swift"), true);
  assertEquals(tagsEqual("SWIFT", "swift"), true);
});

Deno.test("tagsEqual - different tags", () => {
  assertEquals(tagsEqual("Swift", "Rust"), false);
});

// tagIncludes
Deno.test("tagIncludes - exact match", () => {
  assertEquals(tagIncludes(["Swift", "Rust"], "Swift"), true);
});

Deno.test("tagIncludes - case-insensitive match", () => {
  assertEquals(tagIncludes(["Swift", "Rust"], "swift"), true);
  assertEquals(tagIncludes(["Swift", "Rust"], "SWIFT"), true);
});

Deno.test("tagIncludes - no match", () => {
  assertEquals(tagIncludes(["Swift", "Rust"], "Go"), false);
});

Deno.test("tagIncludes - empty array", () => {
  assertEquals(tagIncludes([], "Swift"), false);
});

// findExistingTag
Deno.test("findExistingTag - returns existing casing", () => {
  assertEquals(findExistingTag(["Swift", "Rust"], "swift"), "Swift");
  assertEquals(findExistingTag(["Swift", "Rust"], "RUST"), "Rust");
});

Deno.test("findExistingTag - returns null when not found", () => {
  assertEquals(findExistingTag(["Swift", "Rust"], "Go"), null);
});

Deno.test("findExistingTag - returns first match", () => {
  assertEquals(findExistingTag(["Swift", "swift"], "SWIFT"), "Swift");
});

// resolveTagCasing
Deno.test("resolveTagCasing - maps to existing casing", () => {
  const result = resolveTagCasing(["swift", "RUST"], ["Swift", "Rust"]);
  assertEquals(result, ["Swift", "Rust"]);
});

Deno.test("resolveTagCasing - keeps new tag casing", () => {
  const result = resolveTagCasing(["swift", "NewTag"], ["Swift"]);
  assertEquals(result, ["Swift", "NewTag"]);
});

Deno.test("resolveTagCasing - deduplicates case-insensitively", () => {
  const result = resolveTagCasing(["Swift", "swift", "SWIFT"], ["Swift"]);
  assertEquals(result, ["Swift"]);
});

Deno.test("resolveTagCasing - empty inputs", () => {
  assertEquals(resolveTagCasing([], ["Swift"]), []);
  assertEquals(resolveTagCasing(["swift"], []), ["swift"]);
});

// deduplicateTagsCaseInsensitive
Deno.test("deduplicateTagsCaseInsensitive - keeps first occurrence", () => {
  assertEquals(
    deduplicateTagsCaseInsensitive(["Swift", "swift", "SWIFT"]),
    ["Swift"],
  );
});

Deno.test("deduplicateTagsCaseInsensitive - preserves order", () => {
  assertEquals(
    deduplicateTagsCaseInsensitive(["Rust", "swift", "Go", "RUST"]),
    ["Rust", "swift", "Go"],
  );
});

Deno.test("deduplicateTagsCaseInsensitive - no duplicates unchanged", () => {
  assertEquals(
    deduplicateTagsCaseInsensitive(["Swift", "Rust", "Go"]),
    ["Swift", "Rust", "Go"],
  );
});

Deno.test("deduplicateTagsCaseInsensitive - empty array", () => {
  assertEquals(deduplicateTagsCaseInsensitive([]), []);
});
