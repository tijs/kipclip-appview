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

Deno.test("extractUrlMetadata - extracts favicon from tag with data-base-href", async () => {
  // GitHub uses data-base-href after href; greedy regex would match the wrong one
  const html = `<!DOCTYPE html><html><head>
    <title>GitHub Repo</title>
    <link rel="icon" class="js-site-favicon" type="image/svg+xml" href="https://github.githubassets.com/favicons/favicon.svg" data-base-href="https://github.githubassets.com/favicons/favicon">
  </head><body></body></html>`;
  const mockFetcher = createMockFetcher(
    new Map([[
      "github.com",
      new Response(html, {
        status: 200,
        headers: { "Content-Type": "text/html" },
      }),
    ]]),
  );

  const metadata = await extractUrlMetadataWithFetcher(
    "https://github.com/example/repo",
    mockFetcher,
  );

  assertEquals(
    metadata.favicon,
    "https://github.githubassets.com/favicons/favicon.svg",
  );
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

// ============================================================================
// Security Tests: SSRF Protection
// ============================================================================

Deno.test("SSRF protection - blocks localhost", async () => {
  let fetchCalled = false;
  const mockFetcher = () => {
    fetchCalled = true;
    return Promise.resolve(createHtmlResponse({ title: "Should not fetch" }));
  };

  const metadata = await extractUrlMetadataWithFetcher(
    "http://localhost:3000/admin",
    mockFetcher,
  );

  assertEquals(fetchCalled, false, "Should not call fetch for localhost");
  assertEquals(metadata.title, "localhost");
});

Deno.test("SSRF protection - blocks 127.0.0.1", async () => {
  let fetchCalled = false;
  const mockFetcher = () => {
    fetchCalled = true;
    return Promise.resolve(createHtmlResponse({ title: "Should not fetch" }));
  };

  const metadata = await extractUrlMetadataWithFetcher(
    "http://127.0.0.1:8080/secret",
    mockFetcher,
  );

  assertEquals(fetchCalled, false, "Should not call fetch for 127.0.0.1");
  assertEquals(metadata.title, "127.0.0.1");
});

Deno.test("SSRF protection - blocks AWS metadata endpoint", async () => {
  let fetchCalled = false;
  const mockFetcher = () => {
    fetchCalled = true;
    return Promise.resolve(createHtmlResponse({ title: "Should not fetch" }));
  };

  const metadata = await extractUrlMetadataWithFetcher(
    "http://169.254.169.254/latest/meta-data/",
    mockFetcher,
  );

  assertEquals(
    fetchCalled,
    false,
    "Should not call fetch for metadata endpoint",
  );
  assertEquals(metadata.title, "169.254.169.254");
});

Deno.test("SSRF protection - blocks private 10.x.x.x range", async () => {
  let fetchCalled = false;
  const mockFetcher = () => {
    fetchCalled = true;
    return Promise.resolve(createHtmlResponse({ title: "Should not fetch" }));
  };

  const metadata = await extractUrlMetadataWithFetcher(
    "http://10.0.0.1/internal",
    mockFetcher,
  );

  assertEquals(fetchCalled, false, "Should not call fetch for 10.x range");
  assertEquals(metadata.title, "10.0.0.1");
});

Deno.test("SSRF protection - blocks private 192.168.x.x range", async () => {
  let fetchCalled = false;
  const mockFetcher = () => {
    fetchCalled = true;
    return Promise.resolve(createHtmlResponse({ title: "Should not fetch" }));
  };

  const metadata = await extractUrlMetadataWithFetcher(
    "http://192.168.1.1/router",
    mockFetcher,
  );

  assertEquals(fetchCalled, false, "Should not call fetch for 192.168.x range");
  assertEquals(metadata.title, "192.168.1.1");
});

Deno.test("SSRF protection - blocks private 172.16-31.x.x range", async () => {
  let fetchCalled = false;
  const mockFetcher = () => {
    fetchCalled = true;
    return Promise.resolve(createHtmlResponse({ title: "Should not fetch" }));
  };

  const metadata = await extractUrlMetadataWithFetcher(
    "http://172.16.0.1/internal",
    mockFetcher,
  );

  assertEquals(fetchCalled, false, "Should not call fetch for 172.16.x range");
  assertEquals(metadata.title, "172.16.0.1");
});

Deno.test("SSRF protection - allows public URLs", async () => {
  let fetchCalled = false;
  const mockFetcher = createMockFetcher(
    new Map([
      [
        "github.com",
        createHtmlResponse({ title: "GitHub" }),
      ],
    ]),
  );

  const wrappedFetcher: typeof fetch = (input, init) => {
    fetchCalled = true;
    return mockFetcher(input, init);
  };

  const metadata = await extractUrlMetadataWithFetcher(
    "https://github.com/",
    wrappedFetcher,
  );

  assertEquals(fetchCalled, true, "Should call fetch for public URLs");
  assertEquals(metadata.title, "GitHub");
});

// ============================================================================
// Security Tests: Output Sanitization
// ============================================================================

Deno.test("Sanitization - truncates very long titles", async () => {
  const longTitle = "A".repeat(300);
  const mockFetcher = createMockFetcher(
    new Map([
      [
        "example.com",
        createHtmlResponse({ title: longTitle }),
      ],
    ]),
  );

  const metadata = await extractUrlMetadataWithFetcher(
    "https://example.com/page",
    mockFetcher,
  );

  assertEquals(
    metadata.title?.length,
    200,
    "Title should be truncated to 200 chars",
  );
});

Deno.test("Sanitization - truncates very long descriptions", async () => {
  const longDesc = "B".repeat(600);
  const mockFetcher = createMockFetcher(
    new Map([
      [
        "example.com",
        createHtmlResponse({ title: "Title", description: longDesc }),
      ],
    ]),
  );

  const metadata = await extractUrlMetadataWithFetcher(
    "https://example.com/page",
    mockFetcher,
  );

  assertEquals(
    metadata.description?.length,
    500,
    "Description should be truncated to 500 chars",
  );
});

Deno.test("Sanitization - removes control characters from title", async () => {
  const html = `
<!DOCTYPE html>
<html>
<head><title>Title\x00with\x1Fcontrol\x7Fchars</title></head>
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

  assertEquals(metadata.title, "Titlewithcontrolchars");
});

Deno.test("Sanitization - collapses multiple spaces", async () => {
  const html = `
<!DOCTYPE html>
<html>
<head><title>Title   with    multiple     spaces</title></head>
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

  assertEquals(metadata.title, "Title with multiple spaces");
});

Deno.test("Sanitization - rejects javascript: favicon URL", async () => {
  const html = `
<!DOCTYPE html>
<html>
<head>
<title>Evil Page</title>
<link rel="icon" href="javascript:alert('xss')">
</head>
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

  // Should fall back to default favicon, not the javascript: URL
  assertEquals(metadata.favicon, "https://example.com/favicon.ico");
});

Deno.test("Sanitization - rejects data: favicon URL", async () => {
  const html = `
<!DOCTYPE html>
<html>
<head>
<title>Evil Page</title>
<link rel="icon" href="data:text/html,<script>alert('xss')</script>">
</head>
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

  // Should fall back to default favicon, not the data: URL
  assertEquals(metadata.favicon, "https://example.com/favicon.ico");
});

Deno.test("Sanitization - allows valid http favicon URL", async () => {
  const mockFetcher = createMockFetcher(
    new Map([
      [
        "example.com",
        createHtmlResponse({
          title: "Title",
          favicon: "https://cdn.example.com/icon.png",
        }),
      ],
    ]),
  );

  const metadata = await extractUrlMetadataWithFetcher(
    "https://example.com/page",
    mockFetcher,
  );

  assertEquals(metadata.favicon, "https://cdn.example.com/icon.png");
});
