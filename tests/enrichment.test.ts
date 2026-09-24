/**
 * Tests for URL metadata extraction.
 * Uses mock fetcher to avoid network calls.
 */

import "./test-setup.ts";

import { assert, assertEquals } from "@std/assert";
import {
  extractUrlMetadataWithFetcher,
  isNonEmptyUrlMetadata,
} from "../lib/enrichment.ts";
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

// ============================================================================
// YouTube-aware dispatch
// ============================================================================

const YT_VIDEO_ID = "dQw4w9WgXcQ";
const YT_TITLE = "Rick Astley - Never Gonna Give You Up (Official Video)";
const YT_DESCRIPTION = "We're no strangers to love. You know the rules.";
const YT_THUMB = `https://i.ytimg.com/vi/${YT_VIDEO_ID}/hqdefault.jpg`;

function youtubeOembedResponse(
  overrides: Record<string, unknown> = {},
): Response {
  return new Response(
    JSON.stringify({
      type: "video",
      title: YT_TITLE,
      author_name: "Rick Astley",
      provider_name: "YouTube",
      thumbnail_url: YT_THUMB,
      ...overrides,
    }),
    {
      status: 200,
      headers: { "Content-Type": "application/json" },
    },
  );
}

function youtubePageResponse(description = YT_DESCRIPTION): Response {
  const html = `<!DOCTYPE html><html><head>
    <meta name="description" content="${description}">
  </head><body></body></html>`;
  return new Response(html, {
    status: 200,
    headers: { "Content-Type": "text/html" },
  });
}

function youtubeMockFetcher(
  oembed: Response | null,
  page: Response | null = null,
): typeof fetch {
  const responses = new Map<string, Response>();
  if (oembed) responses.set("oembed", oembed);
  if (page) responses.set("watch?v=", page);
  return createMockFetcher(responses);
}

Deno.test("extractUrlMetadata - dispatches YouTube watch URL to specialized resolver", async () => {
  const metadata = await extractUrlMetadataWithFetcher(
    `https://www.youtube.com/watch?v=${YT_VIDEO_ID}`,
    youtubeMockFetcher(youtubeOembedResponse(), youtubePageResponse()),
  );

  assertEquals(metadata.title, YT_TITLE);
  assertEquals(metadata.description, YT_DESCRIPTION);
  assertEquals(metadata.image, YT_THUMB);
  assertEquals(metadata.favicon, "https://www.youtube.com/favicon.ico");
});

Deno.test("extractUrlMetadata - youtu.be URL resolves through its canonical watch URL", async () => {
  const fetchedUrls: string[] = [];
  const base = youtubeMockFetcher(
    youtubeOembedResponse(),
    youtubePageResponse(),
  );
  const recording = ((input: RequestInfo | URL, init?: RequestInit) => {
    fetchedUrls.push(typeof input === "string" ? input : String(input));
    return base(input, init);
  }) as typeof fetch;

  const metadata = await extractUrlMetadataWithFetcher(
    `https://youtu.be/${YT_VIDEO_ID}?si=share`,
    recording,
  );

  assertEquals(metadata.title, YT_TITLE);
  assert(
    fetchedUrls.some((u) => u.includes("oembed")),
    `oEmbed should be fetched via canonical URL, got ${fetchedUrls.join(", ")}`,
  );
  assert(
    fetchedUrls.some((u) => u.includes(`v=${YT_VIDEO_ID}`)),
    `oEmbed URL should carry canonical watch URL, got ${
      fetchedUrls.join(", ")
    }`,
  );
});

Deno.test("extractUrlMetadata - YouTube metadata failure returns no fabricated title", async () => {
  const metadata = await extractUrlMetadataWithFetcher(
    `https://www.youtube.com/watch?v=${YT_VIDEO_ID}`,
    youtubeMockFetcher(
      new Response("Not Found", { status: 404 }),
    ),
  );

  assertEquals(metadata.title, undefined);
  assertEquals(metadata.description, undefined);
  assertEquals(metadata.image, undefined);
  assertEquals(metadata.favicon, undefined);
});

Deno.test("extractUrlMetadata - YouTube thumbnail falls back to deterministic i.ytimg.com", async () => {
  const metadata = await extractUrlMetadataWithFetcher(
    `https://youtu.be/${YT_VIDEO_ID}`,
    youtubeMockFetcher(youtubeOembedResponse({ thumbnail_url: undefined })),
  );

  assertEquals(metadata.title, YT_TITLE);
  assertEquals(metadata.image, YT_THUMB);
});

Deno.test("extractUrlMetadata - non-video YouTube URLs take the generic path", async () => {
  const mockFetcher = createMockFetcher(
    new Map([
      [
        "youtube.com",
        createHtmlResponse({ title: "Channel Page" }),
      ],
    ]),
  );

  const metadata = await extractUrlMetadataWithFetcher(
    "https://www.youtube.com/@somechannel",
    mockFetcher,
  );

  assertEquals(metadata.title, "Channel Page");
});

// ============================================================================
// Non-empty metadata guard (empty results must never be persisted)
// ============================================================================

Deno.test("isNonEmptyUrlMetadata - false only when no field carries a value", () => {
  assertEquals(isNonEmptyUrlMetadata({}), false);
  assertEquals(isNonEmptyUrlMetadata({ title: undefined }), false);
  assertEquals(
    isNonEmptyUrlMetadata({
      title: "",
      description: "",
      favicon: "",
      image: "",
    }),
    false,
  );
  assertEquals(isNonEmptyUrlMetadata({ title: "T" }), true);
  assertEquals(isNonEmptyUrlMetadata({ description: "D" }), true);
  assertEquals(isNonEmptyUrlMetadata({ favicon: "F" }), true);
  assertEquals(isNonEmptyUrlMetadata({ image: "I" }), true);
});

Deno.test("isNonEmptyUrlMetadata - a recognized YouTube URL with failed fetches yields an empty result", async () => {
  // Every fetch 404s: the specialized resolver must not fabricate a title,
  // so the guard reports the result as empty for the caller to retry.
  const metadata = await extractUrlMetadataWithFetcher(
    "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    createMockFetcher(new Map()),
  );
  assertEquals(metadata, {});
  assertEquals(isNonEmptyUrlMetadata(metadata), false);
});
