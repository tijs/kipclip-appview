import { assertEquals, assertThrows } from "@std/assert";
import {
  detectFormat,
  parseBookmarkFile,
  parseInstapaperCsv,
  parseNetscapeHtml,
  parsePinboardJson,
  parsePocketCsv,
} from "../lib/import-parsers.ts";

// ---------------------------------------------------------------------------
// Format detection
// ---------------------------------------------------------------------------

Deno.test("detectFormat - detects Netscape HTML by DOCTYPE", () => {
  assertEquals(
    detectFormat("<!DOCTYPE NETSCAPE-Bookmark-file-1>\n<DL>"),
    "netscape",
  );
});

Deno.test("detectFormat - detects Netscape HTML by DT tag", () => {
  assertEquals(
    detectFormat('<DL><DT><A HREF="https://example.com">Test</A></DL>'),
    "netscape",
  );
});

Deno.test("detectFormat - detects Pinboard JSON", () => {
  assertEquals(
    detectFormat('[{"href":"https://example.com","description":"Test"}]'),
    "pinboard",
  );
});

Deno.test("detectFormat - detects Pocket CSV", () => {
  assertEquals(
    detectFormat("url,title,tags,time_added\nhttps://example.com,Test,,"),
    "pocket",
  );
});

Deno.test("detectFormat - detects Instapaper CSV", () => {
  assertEquals(
    detectFormat(
      "URL,Title,Selection,Folder\nhttps://example.com,Test,,Unread",
    ),
    "instapaper",
  );
});

Deno.test("detectFormat - returns null for unrecognized content", () => {
  assertEquals(detectFormat("just some random text"), null);
  assertEquals(detectFormat(""), null);
  assertEquals(detectFormat("{}"), null);
});

Deno.test("detectFormat - returns null for empty JSON array", () => {
  assertEquals(detectFormat("[]"), null);
});

Deno.test("detectFormat - returns null for JSON array without href", () => {
  assertEquals(detectFormat('[{"url":"https://example.com"}]'), null);
});

// ---------------------------------------------------------------------------
// Netscape HTML parser
// ---------------------------------------------------------------------------

Deno.test("parseNetscapeHtml - parses fixture file", async () => {
  const html = await Deno.readTextFile("tests/fixtures/bookmarks.html");
  const bookmarks = parseNetscapeHtml(html);

  assertEquals(bookmarks.length, 5);
  assertEquals(bookmarks[0].url, "https://example.com/article-one");
  assertEquals(bookmarks[0].title, "First Article");
  assertEquals(bookmarks[0].tags, ["tech", "news"]);
});

Deno.test("parseNetscapeHtml - converts ADD_DATE unix timestamp", async () => {
  const html = await Deno.readTextFile("tests/fixtures/bookmarks.html");
  const bookmarks = parseNetscapeHtml(html);

  // 1700000000 = 2023-11-14T22:13:20.000Z
  assertEquals(bookmarks[0].createdAt, "2023-11-14T22:13:20.000Z");
});

Deno.test("parseNetscapeHtml - handles bookmarks without tags", async () => {
  const html = await Deno.readTextFile("tests/fixtures/bookmarks.html");
  const bookmarks = parseNetscapeHtml(html);

  // Fourth bookmark has no TAGS attribute
  const noTags = bookmarks.find(
    (b) => b.url === "https://docs.example.com/guide",
  );
  assertEquals(noTags?.tags, []);
});

Deno.test("parseNetscapeHtml - skips non-HTTP URLs", () => {
  const html =
    '<DL><DT><A HREF="javascript:void(0)">Bad</A><DT><A HREF="https://good.com">Good</A></DL>';
  const bookmarks = parseNetscapeHtml(html);
  assertEquals(bookmarks.length, 1);
  assertEquals(bookmarks[0].url, "https://good.com");
});

Deno.test("parseNetscapeHtml - returns empty for no links", () => {
  assertEquals(parseNetscapeHtml("<html><body></body></html>"), []);
});

Deno.test("parseNetscapeHtml - handles empty title", () => {
  const html = '<DL><DT><A HREF="https://example.com"></A></DL>';
  const bookmarks = parseNetscapeHtml(html);
  assertEquals(bookmarks.length, 1);
  assertEquals(bookmarks[0].title, undefined);
});

// ---------------------------------------------------------------------------
// Pinboard JSON parser
// ---------------------------------------------------------------------------

Deno.test("parsePinboardJson - parses fixture file", async () => {
  const json = await Deno.readTextFile("tests/fixtures/pinboard.json");
  const bookmarks = parsePinboardJson(json);

  assertEquals(bookmarks.length, 5);
  assertEquals(bookmarks[0].url, "https://example.com/pinboard-one");
  assertEquals(bookmarks[0].title, "Pinboard First Link");
  assertEquals(
    bookmarks[0].description,
    "This is a longer description of the first link.",
  );
});

Deno.test("parsePinboardJson - splits space-separated tags", async () => {
  const json = await Deno.readTextFile("tests/fixtures/pinboard.json");
  const bookmarks = parsePinboardJson(json);

  assertEquals(bookmarks[0].tags, ["tech", "programming"]);
  assertEquals(bookmarks[2].tags, ["blog", "reading", "tech"]);
});

Deno.test("parsePinboardJson - preserves ISO 8601 time", async () => {
  const json = await Deno.readTextFile("tests/fixtures/pinboard.json");
  const bookmarks = parsePinboardJson(json);

  assertEquals(bookmarks[0].createdAt, "2024-01-15T10:30:00Z");
});

Deno.test("parsePinboardJson - handles empty tags", async () => {
  const json = await Deno.readTextFile("tests/fixtures/pinboard.json");
  const bookmarks = parsePinboardJson(json);

  // Fourth entry has empty tags
  assertEquals(bookmarks[3].tags, []);
});

Deno.test("parsePinboardJson - handles empty extended", async () => {
  const json = await Deno.readTextFile("tests/fixtures/pinboard.json");
  const bookmarks = parsePinboardJson(json);

  assertEquals(bookmarks[1].description, undefined);
});

Deno.test("parsePinboardJson - returns empty for invalid JSON", () => {
  assertEquals(parsePinboardJson("not json"), []);
});

Deno.test("parsePinboardJson - returns empty for non-array JSON", () => {
  assertEquals(parsePinboardJson('{"key": "value"}'), []);
});

Deno.test("parsePinboardJson - skips entries with invalid URLs", () => {
  const json = JSON.stringify([
    { href: "not-a-url", description: "Bad" },
    { href: "https://good.com", description: "Good" },
  ]);
  const bookmarks = parsePinboardJson(json);
  assertEquals(bookmarks.length, 1);
  assertEquals(bookmarks[0].url, "https://good.com");
});

// ---------------------------------------------------------------------------
// Pocket CSV parser
// ---------------------------------------------------------------------------

Deno.test("parsePocketCsv - parses fixture file", async () => {
  const csv = await Deno.readTextFile("tests/fixtures/pocket.csv");
  const bookmarks = parsePocketCsv(csv);

  assertEquals(bookmarks.length, 5);
  assertEquals(bookmarks[0].url, "https://example.com/pocket-one");
  assertEquals(bookmarks[0].title, "Pocket First Article");
});

Deno.test("parsePocketCsv - parses comma-separated tags", async () => {
  const csv = await Deno.readTextFile("tests/fixtures/pocket.csv");
  const bookmarks = parsePocketCsv(csv);

  assertEquals(bookmarks[0].tags, ["tech", "news"]);
});

Deno.test("parsePocketCsv - converts unix timestamp to ISO", async () => {
  const csv = await Deno.readTextFile("tests/fixtures/pocket.csv");
  const bookmarks = parsePocketCsv(csv);

  assertEquals(bookmarks[0].createdAt, "2023-11-14T22:13:20.000Z");
});

Deno.test("parsePocketCsv - handles empty tags", async () => {
  const csv = await Deno.readTextFile("tests/fixtures/pocket.csv");
  const bookmarks = parsePocketCsv(csv);

  // Fourth row has empty tags
  assertEquals(bookmarks[3].tags, []);
});

Deno.test("parsePocketCsv - handles quoted fields with commas", async () => {
  const csv = await Deno.readTextFile("tests/fixtures/pocket.csv");
  const bookmarks = parsePocketCsv(csv);

  assertEquals(bookmarks[1].title, "A Title, With Commas");
});

Deno.test("parsePocketCsv - returns empty for header-only CSV", () => {
  assertEquals(parsePocketCsv("url,title,tags,time_added\n"), []);
});

Deno.test("parsePocketCsv - skips invalid URLs", () => {
  const csv = "url,title,tags,time_added\nnot-a-url,Bad,,\n";
  assertEquals(parsePocketCsv(csv), []);
});

// ---------------------------------------------------------------------------
// Instapaper CSV parser
// ---------------------------------------------------------------------------

Deno.test("parseInstapaperCsv - parses fixture file", async () => {
  const csv = await Deno.readTextFile("tests/fixtures/instapaper.csv");
  const bookmarks = parseInstapaperCsv(csv);

  assertEquals(bookmarks.length, 5);
  assertEquals(bookmarks[0].url, "https://example.com/insta-one");
  assertEquals(bookmarks[0].title, "Instapaper First Article");
});

Deno.test("parseInstapaperCsv - maps Folder to tags, skipping Unread/Archive", async () => {
  const csv = await Deno.readTextFile("tests/fixtures/instapaper.csv");
  const bookmarks = parseInstapaperCsv(csv);

  // Unread folder → no tags
  assertEquals(bookmarks[0].tags, []);
  // Tech folder → tag
  assertEquals(bookmarks[1].tags, ["Tech"]);
  // Archive folder → no tags
  assertEquals(bookmarks[3].tags, []);
  // News folder → tag
  assertEquals(bookmarks[4].tags, ["News"]);
});

Deno.test("parseInstapaperCsv - maps Selection to description", async () => {
  const csv = await Deno.readTextFile("tests/fixtures/instapaper.csv");
  const bookmarks = parseInstapaperCsv(csv);

  assertEquals(bookmarks[1].description, "A highlighted passage");
  assertEquals(bookmarks[2].description, "Some selected text");
  assertEquals(bookmarks[0].description, undefined);
});

Deno.test("parseInstapaperCsv - handles quoted fields with commas", async () => {
  const csv = await Deno.readTextFile("tests/fixtures/instapaper.csv");
  const bookmarks = parseInstapaperCsv(csv);

  assertEquals(bookmarks[2].title, "A Blog Post, Saved");
});

Deno.test("parseInstapaperCsv - returns empty for header-only CSV", () => {
  assertEquals(
    parseInstapaperCsv("URL,Title,Selection,Folder\n"),
    [],
  );
});

// ---------------------------------------------------------------------------
// parseBookmarkFile (auto-detect + parse)
// ---------------------------------------------------------------------------

Deno.test("parseBookmarkFile - detects and parses Netscape HTML", async () => {
  const html = await Deno.readTextFile("tests/fixtures/bookmarks.html");
  const result = parseBookmarkFile(html);

  assertEquals(result.format, "netscape");
  assertEquals(result.bookmarks.length, 5);
});

Deno.test("parseBookmarkFile - detects and parses Pinboard JSON", async () => {
  const json = await Deno.readTextFile("tests/fixtures/pinboard.json");
  const result = parseBookmarkFile(json);

  assertEquals(result.format, "pinboard");
  assertEquals(result.bookmarks.length, 5);
});

Deno.test("parseBookmarkFile - detects and parses Pocket CSV", async () => {
  const csv = await Deno.readTextFile("tests/fixtures/pocket.csv");
  const result = parseBookmarkFile(csv);

  assertEquals(result.format, "pocket");
  assertEquals(result.bookmarks.length, 5);
});

Deno.test("parseBookmarkFile - detects and parses Instapaper CSV", async () => {
  const csv = await Deno.readTextFile("tests/fixtures/instapaper.csv");
  const result = parseBookmarkFile(csv);

  assertEquals(result.format, "instapaper");
  assertEquals(result.bookmarks.length, 5);
});

Deno.test("parseBookmarkFile - throws for unrecognized format", () => {
  assertThrows(
    () => parseBookmarkFile("unrecognized content"),
    Error,
    "Unrecognized file format",
  );
});

// ---------------------------------------------------------------------------
// CSV edge cases
// ---------------------------------------------------------------------------

Deno.test("parsePocketCsv - handles escaped quotes in CSV", () => {
  const csv =
    'url,title,tags,time_added\nhttps://example.com,"""Quoted"" Title",,\n';
  const bookmarks = parsePocketCsv(csv);
  assertEquals(bookmarks.length, 1);
  assertEquals(bookmarks[0].title, '"Quoted" Title');
});

// ---------------------------------------------------------------------------
// Dedup within file (multiple identical URLs)
// ---------------------------------------------------------------------------

Deno.test("parsePinboardJson - does not deduplicate (caller responsibility)", () => {
  const json = JSON.stringify([
    { href: "https://example.com/dup", description: "First" },
    { href: "https://example.com/dup", description: "Second" },
  ]);
  const bookmarks = parsePinboardJson(json);
  assertEquals(bookmarks.length, 2);
});
