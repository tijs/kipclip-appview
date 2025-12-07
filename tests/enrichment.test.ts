/**
 * Tests for URL metadata extraction.
 * Uses mock fetcher to avoid network calls.
 */

import "./test-setup.ts";

import { assertEquals } from "@std/assert";
import { extractUrlMetadataWithFetcher } from "../lib/enrichment.ts";
import { createHtmlResponse, createMockFetcher } from "./test-helpers.ts";

Deno.test("extractUrlMetadata - parses title from <title> tag", async () => {
  const mockFetcher = createMockFetcher(
    new Map([
      [
        "example.com",
        createHtmlResponse({ title: "Example Page Title" }),
      ],
    ]),
  );

  const metadata = await extractUrlMetadataWithFetcher(
    "https://example.com/page",
    mockFetcher,
  );

  assertEquals(metadata.title, "Example Page Title");
});

Deno.test("extractUrlMetadata - parses og:title as fallback", async () => {
  const mockFetcher = createMockFetcher(
    new Map([
      [
        "example.com",
        createHtmlResponse({ ogTitle: "OG Title Fallback" }),
      ],
    ]),
  );

  const metadata = await extractUrlMetadataWithFetcher(
    "https://example.com/page",
    mockFetcher,
  );

  assertEquals(metadata.title, "OG Title Fallback");
});

Deno.test("extractUrlMetadata - prefers <title> over og:title", async () => {
  const mockFetcher = createMockFetcher(
    new Map([
      [
        "example.com",
        createHtmlResponse({
          title: "HTML Title",
          ogTitle: "OG Title",
        }),
      ],
    ]),
  );

  const metadata = await extractUrlMetadataWithFetcher(
    "https://example.com/page",
    mockFetcher,
  );

  assertEquals(metadata.title, "HTML Title");
});

Deno.test("extractUrlMetadata - parses description from meta tag", async () => {
  const mockFetcher = createMockFetcher(
    new Map([
      [
        "example.com",
        createHtmlResponse({
          title: "Title",
          description: "This is the page description",
        }),
      ],
    ]),
  );

  const metadata = await extractUrlMetadataWithFetcher(
    "https://example.com/page",
    mockFetcher,
  );

  assertEquals(metadata.description, "This is the page description");
});

Deno.test("extractUrlMetadata - parses og:description as fallback", async () => {
  const mockFetcher = createMockFetcher(
    new Map([
      [
        "example.com",
        createHtmlResponse({
          title: "Title",
          ogDescription: "OG Description",
        }),
      ],
    ]),
  );

  const metadata = await extractUrlMetadataWithFetcher(
    "https://example.com/page",
    mockFetcher,
  );

  assertEquals(metadata.description, "OG Description");
});

Deno.test("extractUrlMetadata - extracts favicon URL", async () => {
  const mockFetcher = createMockFetcher(
    new Map([
      [
        "example.com",
        createHtmlResponse({
          title: "Title",
          favicon: "/images/favicon.png",
        }),
      ],
    ]),
  );

  const metadata = await extractUrlMetadataWithFetcher(
    "https://example.com/page",
    mockFetcher,
  );

  assertEquals(metadata.favicon, "https://example.com/images/favicon.png");
});

Deno.test("extractUrlMetadata - defaults favicon to /favicon.ico", async () => {
  const mockFetcher = createMockFetcher(
    new Map([
      [
        "example.com",
        createHtmlResponse({ title: "Title" }),
      ],
    ]),
  );

  const metadata = await extractUrlMetadataWithFetcher(
    "https://example.com/page",
    mockFetcher,
  );

  assertEquals(metadata.favicon, "https://example.com/favicon.ico");
});

Deno.test("extractUrlMetadata - handles fetch failure gracefully", async () => {
  const mockFetcher = createMockFetcher(
    new Map([
      [
        "example.com",
        new Response("Internal Server Error", { status: 500 }),
      ],
    ]),
  );

  const metadata = await extractUrlMetadataWithFetcher(
    "https://example.com/page",
    mockFetcher,
  );

  // Should return hostname as title on error
  assertEquals(metadata.title, "example.com");
});

Deno.test("extractUrlMetadata - handles non-HTML content", async () => {
  const mockFetcher = createMockFetcher(
    new Map([
      [
        "example.com",
        new Response('{"data": "json"}', {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ],
    ]),
  );

  const metadata = await extractUrlMetadataWithFetcher(
    "https://example.com/api/data",
    mockFetcher,
  );

  // Should return hostname for non-HTML
  assertEquals(metadata.title, "example.com");
});

Deno.test("extractUrlMetadata - decodes HTML entities in title", async () => {
  const html = `
<!DOCTYPE html>
<html>
<head><title>Tom &amp; Jerry&#39;s &quot;Show&quot;</title></head>
<body></body>
</html>`;

  const mockFetcher = createMockFetcher(
    new Map([
      [
        "example.com",
        new Response(html, {
          status: 200,
          headers: { "Content-Type": "text/html" },
        }),
      ],
    ]),
  );

  const metadata = await extractUrlMetadataWithFetcher(
    "https://example.com/page",
    mockFetcher,
  );

  assertEquals(metadata.title, 'Tom & Jerry\'s "Show"');
});

Deno.test("extractUrlMetadata - uses hostname when no title found", async () => {
  const html = `<!DOCTYPE html><html><head></head><body></body></html>`;

  const mockFetcher = createMockFetcher(
    new Map([
      [
        "example.com",
        new Response(html, {
          status: 200,
          headers: { "Content-Type": "text/html" },
        }),
      ],
    ]),
  );

  const metadata = await extractUrlMetadataWithFetcher(
    "https://example.com/page",
    mockFetcher,
  );

  assertEquals(metadata.title, "example.com");
});
