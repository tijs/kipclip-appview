/**
 * Tests for the YouTube-aware metadata module.
 * Deterministic: all fetches are mocked; no live YouTube traffic.
 */

import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  deterministicYouTubeThumbnail,
  fetchBounded,
  fetchYouTubeMetadata,
  isKnownDefaultYouTubeDescription,
  isKnownDefaultYouTubeTitle,
  parseYouTubeVideoUrl,
  YouTubeMetadataError,
} from "../lib/youtube-metadata.ts";
import { createMockFetcher } from "./test-helpers.ts";

const VIDEO_ID = "dQw4w9WgXcQ";
const CANONICAL = `https://www.youtube.com/watch?v=${VIDEO_ID}`;

function oembedResponse(overrides: Record<string, unknown> = {}): Response {
  return new Response(
    JSON.stringify({
      type: "video",
      version: "1.0",
      title: "Rick Astley - Never Gonna Give You Up (Official Video)",
      author_name: "Rick Astley",
      author_url: "https://www.youtube.com/@RickAstley",
      provider_name: "YouTube",
      thumbnail_url: `https://i.ytimg.com/vi/${VIDEO_ID}/hqdefault.jpg`,
      thumbnail_width: 480,
      thumbnail_height: 360,
      width: 200,
      height: 113,
      html: "<iframe></iframe>",
      ...overrides,
    }),
    {
      status: 200,
      headers: { "Content-Type": "application/json" },
    },
  );
}

function watchPageResponse(
  description = "We're no strangers to love. You know the rules and so do I.",
): Response {
  const html = `<!DOCTYPE html><html><head>
    <title>Rick Astley - Never Gonna Give You Up (Official Video) - YouTube</title>
    <meta name="description" content="${description}">
    <meta property="og:description" content="${description}">
  </head><body></body></html>`;
  return new Response(html, {
    status: 200,
    headers: { "Content-Type": "text/html" },
  });
}

// ============================================================================
// parseYouTubeVideoUrl
// ============================================================================

Deno.test("parseYouTubeVideoUrl - recognizes watch variants with a valid ID", () => {
  const cases: [string, string][] = [
    ["https://www.youtube.com/watch?v=dQw4w9WgXcQ", VIDEO_ID],
    ["https://youtube.com/watch?v=dQw4w9WgXcQ", VIDEO_ID],
    ["https://m.youtube.com/watch?v=dQw4w9WgXcQ", VIDEO_ID],
    ["http://www.youtube.com/watch?v=dQw4w9WgXcQ", VIDEO_ID],
    ["https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=30", VIDEO_ID],
    [
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PL123&index=2",
      VIDEO_ID,
    ],
    ["https://www.youtube.com/watch?v=dQw4w9WgXcQ#t=30", VIDEO_ID],
  ];
  for (const [url, id] of cases) {
    const ref = parseYouTubeVideoUrl(url);
    assertEquals(ref?.videoId, id, `videoId for ${url}`);
    assertEquals(ref?.canonicalWatchUrl, CANONICAL, `canonical for ${url}`);
  }
});

Deno.test("parseYouTubeVideoUrl - recognizes youtu.be / shorts / live / embed / v", () => {
  const cases: string[] = [
    `https://youtu.be/${VIDEO_ID}`,
    `https://youtu.be/${VIDEO_ID}?si=abc123`,
    `https://www.youtube.com/shorts/${VIDEO_ID}`,
    `https://www.youtube.com/live/${VIDEO_ID}`,
    `https://www.youtube.com/embed/${VIDEO_ID}`,
    `https://www.youtube.com/v/${VIDEO_ID}`,
    `https://www.youtube-nocookie.com/embed/${VIDEO_ID}`,
  ];
  for (const url of cases) {
    const ref = parseYouTubeVideoUrl(url);
    assertEquals(ref?.videoId, VIDEO_ID, `videoId for ${url}`);
    assertEquals(ref?.canonicalWatchUrl, CANONICAL, `canonical for ${url}`);
  }
});

Deno.test("parseYouTubeVideoUrl - accepts full ID alphabet (case, dash, underscore)", () => {
  const id = "ABc_-123456"; // 11 chars
  assertEquals(parseYouTubeVideoUrl(`https://youtu.be/${id}`)?.videoId, id);
});

Deno.test("parseYouTubeVideoUrl - rejects non-video, malformed and foreign URLs", () => {
  const rejected: string[] = [
    "https://www.youtube.com/",
    "https://www.youtube.com/feed/subscriptions",
    "https://www.youtube.com/watch",
    "https://www.youtube.com/watch?list=PL123",
    "https://www.youtube.com/channel/UC_x5XG1OV2P6uZZ5FSM9Ttw",
    "https://www.youtube.com/@somehandle",
    "https://www.youtube.com/user/someuser",
    "https://www.youtube.com/c/somechannel",
    "https://www.youtube.com/playlist?list=PL123",
    "https://www.youtube.com/results?search_query=hello",
    "https://www.youtube.com/watch?v=short",
    "https://www.youtube.com/watch?v=waytooooooooooolongid",
    "https://www.youtube.com/watch?v=has%20spaces",
    "https://www.youtube.com/shorts/",
    "https://www.youtube.com/embed/",
    "https://www.youtube.com/shorts/short/extra",
    "https://example.com/watch?v=dQw4w9WgXcQ",
    "https://music.youtube.com/watch?v=dQw4w9WgXcQ",
    "ftp://youtu.be/dQw4w9WgXcQ",
    "not a url at all",
  ];
  for (const url of rejected) {
    assertEquals(parseYouTubeVideoUrl(url), null, `should reject ${url}`);
  }
});

Deno.test("parseYouTubeVideoUrl - rejects overlong URLs", () => {
  const long = `https://www.youtube.com/watch?v=${VIDEO_ID}` +
    "&x=" + "a".repeat(3000);
  assertEquals(parseYouTubeVideoUrl(long), null);
});

Deno.test(
  "parseYouTubeVideoUrl - canonicalizes real production URL shapes without mutating the source",
  () => {
    // URL shapes observed on live accounts (372 YouTube bookmark subjects).
    // A bounded public oEmbed probe returned 200 video metadata for four of
    // these and a legitimate 404 for one unavailable video — the parser must
    // handle all five identically.
    const cases: { url: string; id: string }[] = [
      {
        url:
          "http://www.youtube.com/watch?feature=player_embedded&v=2uYs0gJD-LE",
        id: "2uYs0gJD-LE",
      },
      {
        url: "https://m.youtube.com/watch?feature=youtu.be&v=2QUUtjdOubE",
        id: "2QUUtjdOubE",
      },
      {
        url: "https://youtu.be/aXut3s90rUI?is=RX7eJQxV2NDspY2m",
        id: "aXut3s90rUI",
      },
      { url: "https://youtube.com/shorts/XVnPEVTmvJM", id: "XVnPEVTmvJM" },
      { url: "https://youtube.com/live/ChcIGus7IBc", id: "ChcIGus7IBc" },
    ];
    for (const { url, id } of cases) {
      const before = String(url);
      const ref = parseYouTubeVideoUrl(url);
      assertEquals(ref?.videoId, id, `videoId for ${url}`);
      assertEquals(
        ref?.canonicalWatchUrl,
        `https://www.youtube.com/watch?v=${id}`,
        `canonical for ${url}`,
      );
      // Canonicalization derives a NEW URL; the caller's subject must never
      // be rewritten in place.
      assertEquals(String(url), before, `source URL must not be mutated`);
    }
  },
);

// ============================================================================
// deterministicYouTubeThumbnail
// ============================================================================

Deno.test("deterministicYouTubeThumbnail - builds i.ytimg.com URL for valid ID only", () => {
  assertEquals(
    deterministicYouTubeThumbnail(VIDEO_ID),
    `https://i.ytimg.com/vi/${VIDEO_ID}/hqdefault.jpg`,
  );
  assertEquals(deterministicYouTubeThumbnail("short"), undefined);
});

// ============================================================================
// Known default text detection
// ============================================================================

Deno.test("isKnownDefaultYouTubeTitle - detects exporter defaults only", () => {
  assertEquals(isKnownDefaultYouTubeTitle("- YouTube"), true);
  assertEquals(isKnownDefaultYouTubeTitle("YouTube"), true);
  assertEquals(isKnownDefaultYouTubeTitle("  - YouTube  "), true);
  assertEquals(isKnownDefaultYouTubeTitle("My Real Video Title"), false);
  assertEquals(isKnownDefaultYouTubeTitle("My Video - YouTube"), false);
  assertEquals(isKnownDefaultYouTubeTitle(""), false);
  assertEquals(isKnownDefaultYouTubeTitle(undefined), false);
  assertEquals(isKnownDefaultYouTubeTitle(null), false);
});

Deno.test("isKnownDefaultYouTubeDescription - detects generic descriptions only", () => {
  assertEquals(
    isKnownDefaultYouTubeDescription(
      "Share your videos with friends, family, and the world.",
    ),
    true,
  );
  assertEquals(
    isKnownDefaultYouTubeDescription(
      "Enjoy the videos and music you love, upload original content, " +
        "and share it all with friends, family, and the world on YouTube.",
    ),
    true,
  );
  assertEquals(isKnownDefaultYouTubeDescription("A real description"), false);
  assertEquals(isKnownDefaultYouTubeDescription(""), false);
  assertEquals(isKnownDefaultYouTubeDescription(undefined), false);
});

Deno.test(
  "isKnownDefaultYouTubeDescription - recognizes German and Dutch defaults from live data",
  () => {
    // Localized default annotations observed on live accounts: German (68
    // rows) and Dutch (1 row) alongside the existing English default.
    assertEquals(
      isKnownDefaultYouTubeDescription(
        "Auf YouTube findest du die angesagtesten Videos und Tracks. " +
          "Außerdem kannst du eigene Inhalte hochladen und mit Freunden " +
          "oder gleich der ganzen Welt teilen.",
      ),
      true,
    );
    assertEquals(
      isKnownDefaultYouTubeDescription(
        "Bekijk je favoriete video's, luister naar de muziek die je leuk " +
          "vindt, upload originele content en deel alles met vrienden, " +
          "familie en anderen op YouTube.",
      ),
      true,
    );
    // Existing normalization contract still applies: surrounding whitespace
    // and line breaks collapse before the exact comparison.
    assertEquals(
      isKnownDefaultYouTubeDescription(
        "  Auf YouTube findest du die angesagtesten Videos und Tracks.\n" +
          "Außerdem kannst du eigene Inhalte hochladen und mit Freunden " +
          "oder gleich der ganzen Welt teilen.  ",
      ),
      true,
    );
    // Generic-text safety: matching is exact-boilerplate only — a truncated
    // localized default is a real (if short) description and must NOT be
    // classified as boilerplate.
    assertEquals(
      isKnownDefaultYouTubeDescription(
        "Auf YouTube findest du die angesagtesten Videos und Tracks.",
      ),
      false,
    );
  },
);

// ============================================================================
// fetchYouTubeMetadata (oEmbed + bounded watch page)
// ============================================================================

const richFetcher = createMockFetcher(
  new Map<string, Response>([
    ["oembed", oembedResponse()],
    ["watch?v=", watchPageResponse()],
  ]),
);

Deno.test("fetchYouTubeMetadata - merges oEmbed and watch-page description", async () => {
  const ref = { videoId: VIDEO_ID, canonicalWatchUrl: CANONICAL };
  const meta = await fetchYouTubeMetadata(ref, richFetcher);
  assertEquals(
    meta.title,
    "Rick Astley - Never Gonna Give You Up (Official Video)",
  );
  assertEquals(
    meta.description,
    "We're no strangers to love. You know the rules and so do I.",
  );
  assertEquals(
    meta.thumbnailUrl,
    `https://i.ytimg.com/vi/${VIDEO_ID}/hqdefault.jpg`,
  );
});

Deno.test("fetchYouTubeMetadata - watch page failure still yields oEmbed fields", async () => {
  const fetcher = createMockFetcher(
    new Map<string, Response>([
      ["oembed", oembedResponse()],
      [
        "watch?v=",
        new Response("Internal Server Error", { status: 500 }),
      ],
    ]),
  );
  const meta = await fetchYouTubeMetadata(
    { videoId: VIDEO_ID, canonicalWatchUrl: CANONICAL },
    fetcher,
  );
  assertEquals(
    meta.title,
    "Rick Astley - Never Gonna Give You Up (Official Video)",
  );
  assertEquals(meta.description, undefined);
  assertEquals(
    meta.thumbnailUrl,
    `https://i.ytimg.com/vi/${VIDEO_ID}/hqdefault.jpg`,
  );
});

Deno.test("fetchYouTubeMetadata - rejects generic watch-page description", async () => {
  const fetcher = createMockFetcher(
    new Map<string, Response>([
      ["oembed", oembedResponse()],
      [
        "watch?v=",
        watchPageResponse(
          "Share your videos with friends, family, and the world.",
        ),
      ],
    ]),
  );
  const meta = await fetchYouTubeMetadata(
    { videoId: VIDEO_ID, canonicalWatchUrl: CANONICAL },
    fetcher,
  );
  assertEquals(meta.description, undefined);
});

Deno.test("fetchYouTubeMetadata - truncates unbounded descriptions", async () => {
  const fetcher = createMockFetcher(
    new Map<string, Response>([
      ["oembed", oembedResponse()],
      ["watch?v=", watchPageResponse("B".repeat(2000))],
    ]),
  );
  const meta = await fetchYouTubeMetadata(
    { videoId: VIDEO_ID, canonicalWatchUrl: CANONICAL },
    fetcher,
  );
  assertEquals(meta.description?.length, 500);
});

Deno.test("fetchYouTubeMetadata - throws on oEmbed HTTP failure", async () => {
  const fetcher = createMockFetcher(
    new Map<string, Response>([
      ["oembed", new Response("Not Found", { status: 404 })],
    ]),
  );
  await assertRejects(
    () =>
      fetchYouTubeMetadata(
        { videoId: VIDEO_ID, canonicalWatchUrl: CANONICAL },
        fetcher,
      ),
    YouTubeMetadataError,
  );
});

Deno.test("fetchYouTubeMetadata - throws on invalid oEmbed JSON", async () => {
  const fetcher = createMockFetcher(
    new Map<string, Response>([
      [
        "oembed",
        new Response("<html>not json</html>", {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ],
    ]),
  );
  await assertRejects(
    () =>
      fetchYouTubeMetadata(
        { videoId: VIDEO_ID, canonicalWatchUrl: CANONICAL },
        fetcher,
      ),
    YouTubeMetadataError,
  );
});

Deno.test("fetchYouTubeMetadata - throws when oEmbed title is missing or boilerplate", async () => {
  for (
    const overrides of [
      { title: "" },
      { title: "YouTube" },
      { title: "- YouTube" },
    ]
  ) {
    const fetcher = createMockFetcher(
      new Map<string, Response>([["oembed", oembedResponse(overrides)]]),
    );
    let threw = false;
    try {
      await fetchYouTubeMetadata(
        { videoId: VIDEO_ID, canonicalWatchUrl: CANONICAL },
        fetcher,
      );
    } catch (err) {
      threw = err instanceof YouTubeMetadataError;
    }
    assert(
      threw,
      `should reject oEmbed title ${JSON.stringify(overrides.title)}`,
    );
  }
});

Deno.test("fetchYouTubeMetadata - validates oEmbed type field", async () => {
  const fetcher = createMockFetcher(
    new Map<string, Response>([
      ["oembed", oembedResponse({ type: "link" })],
    ]),
  );
  await assertRejects(
    () =>
      fetchYouTubeMetadata(
        { videoId: VIDEO_ID, canonicalWatchUrl: CANONICAL },
        fetcher,
      ),
    YouTubeMetadataError,
  );
});

Deno.test("fetchYouTubeMetadata - rejects thumbnail URLs outside the allowlist", async () => {
  const fetcher = createMockFetcher(
    new Map<string, Response>([
      [
        "oembed",
        oembedResponse({ thumbnail_url: "https://evil.example/steal.png" }),
      ],
    ]),
  );
  const meta = await fetchYouTubeMetadata(
    { videoId: VIDEO_ID, canonicalWatchUrl: CANONICAL },
    fetcher,
  );
  assertEquals(meta.thumbnailUrl, undefined);
});

Deno.test("fetchYouTubeMetadata - fetch rejection propagates as YouTubeMetadataError", async () => {
  const fetcher = (() => {
    return Promise.reject(new TypeError("network down")) as Promise<Response>;
  }) as typeof fetch;
  await assertRejects(
    () =>
      fetchYouTubeMetadata(
        { videoId: VIDEO_ID, canonicalWatchUrl: CANONICAL },
        fetcher,
      ),
    YouTubeMetadataError,
  );
});

// ============================================================================
// fetchBounded (bounded fetch: timeout cleanup, byte cap, redirects)
// ============================================================================

function trackCancels(chunks: Uint8Array[]): {
  response: Response;
  cancelCount: () => number;
} {
  let cancels = 0;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
  // Observe reader.cancel() directly: whether the underlying stream honours a
  // cancellation is a runtime internal (a closed stream treats it as a
  // no-op); the production requirement is that fetchBounded CALLS
  // reader.cancel() once the byte cap is reached.
  const trackedBody = new Proxy(stream, {
    get(target, prop) {
      if (prop === "getReader") {
        return () => {
          const reader = target.getReader();
          return new Proxy(reader, {
            // deno-lint-ignore no-explicit-any
            get(t, p) {
              if (p === "cancel") {
                return (reason?: unknown) => {
                  cancels++;
                  return t.cancel(reason);
                };
              }
              // deno-lint-ignore no-explicit-any
              const value = (t as any)[p];
              return typeof value === "function" ? value.bind(t) : value;
            },
          }) as unknown as ReadableStreamDefaultReader<Uint8Array>;
        };
      }
      // deno-lint-ignore no-explicit-any
      const value = (target as any)[prop];
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as unknown as ReadableStream<Uint8Array>;
  // A stream-backed `new Response(...)` does not propagate reader.cancel() to
  // the underlying stream's cancel callback in Deno, so hand fetchBounded a
  // duck-typed response whose body IS the tracked stream.
  const response = {
    ok: true,
    status: 200,
    headers: new Headers({ "Content-Type": "application/octet-stream" }),
    body: trackedBody,
  } as unknown as Response;
  return { response, cancelCount: () => cancels };
}

function singleResponseFetcher(response: Response): typeof fetch {
  return ((_input: RequestInfo | URL, _init?: RequestInit) =>
    Promise.resolve(response)) as typeof fetch;
}

Deno.test("fetchBounded - clears its timeout after a successful fetch", async () => {
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const created: number[] = [];
  const cleared: number[] = [];
  globalThis.setTimeout = ((
    fn: (...args: unknown[]) => void,
    ms?: number,
  ) => {
    const id = originalSetTimeout(fn, ms ?? 0);
    created.push(id);
    return id;
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((id?: number) => {
    if (id !== undefined) cleared.push(id);
    return originalClearTimeout(id as number);
  }) as typeof clearTimeout;
  try {
    const text = await fetchBounded(
      singleResponseFetcher(new Response("hello", { status: 200 })),
      "https://www.youtube.com/oembed?format=json",
      2_000,
      1024,
      null,
    );
    assertEquals(text, "hello");
    // Every timer fetchBounded created must be cleared — including the
    // success path (previously only the catch path cleared it, leaving an
    // 8-second timer alive after every successful fetch).
    for (const id of created) {
      assert(cleared.includes(id), `timer ${id} must be cleared after success`);
    }
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }
});

Deno.test("fetchBounded - slices an oversized chunk before decoding it", async () => {
  const enc = new TextEncoder();
  const char = "é"; // 2-byte UTF-8 character
  const { response, cancelCount } = trackCancels([
    enc.encode(char.repeat(200)), // 400 bytes delivered as one chunk
  ]);
  const text = await fetchBounded(
    singleResponseFetcher(response),
    "https://example.test/page",
    2_000,
    50,
    null,
  );
  // The 50-byte budget ends exactly on a 2-byte boundary: slicing must happen
  // on the byte array BEFORE decoding, so only the 25 whole characters that
  // fit are decoded. Decoding the full chunk then slicing the string would
  // yield 50 characters — and would have accumulated 400 bytes in memory.
  assertEquals(text, char.repeat(25));
  assertEquals(
    cancelCount(),
    1,
    "reader must be cancelled once the cap is hit",
  );
});

Deno.test("fetchBounded - cancels the reader when chunks reach the byte cap", async () => {
  const enc = new TextEncoder();
  const { response, cancelCount } = trackCancels([
    enc.encode("a".repeat(60)),
    enc.encode("b".repeat(80)),
  ]);
  const text = await fetchBounded(
    singleResponseFetcher(response),
    "https://example.test/page",
    2_000,
    100,
    null,
  );
  assertEquals(text, "a".repeat(60) + "b".repeat(40));
  assertEquals(cancelCount(), 1);
});

Deno.test(
  "fetchBounded - rejects a bodyless response whose declared content length exceeds the cap without reading it",
  async () => {
    let textCalled = false;
    const response = {
      ok: true,
      status: 200,
      headers: new Headers({
        "Content-Type": "text/html",
        "Content-Length": "1048576",
      }),
      body: null,
      text: () => {
        textCalled = true;
        return Promise.resolve("x".repeat(1024 * 1024));
      },
    } as unknown as Response;
    await assertRejects(
      () =>
        fetchBounded(
          singleResponseFetcher(response),
          "https://example.test/page",
          2_000,
          1024,
          null,
        ),
      YouTubeMetadataError,
    );
    assertEquals(
      textCalled,
      false,
      "an oversized declared body must be rejected before any read",
    );
  },
);

Deno.test(
  "fetchBounded - bodyless responses return empty without reading an unbounded text()",
  async () => {
    let textCalled = false;
    const response = {
      ok: true,
      status: 200,
      headers: new Headers({ "Content-Type": "text/html" }),
      body: null,
      text: () => {
        textCalled = true;
        return Promise.resolve("y".repeat(10_000_000));
      },
    } as unknown as Response;
    const text = await fetchBounded(
      singleResponseFetcher(response),
      "https://example.test/page",
      2_000,
      1024,
      null,
    );
    assertEquals(
      text,
      "",
      "a bodyless response has no payload and must not be read unbounded",
    );
    assertEquals(
      textCalled,
      false,
      "an unbounded non-stream body must never be read into memory",
    );
  },
);

Deno.test("fetchBounded - a standard bodyless Response reads as empty", async () => {
  const text = await fetchBounded(
    singleResponseFetcher(new Response(null, { status: 200 })),
    "https://example.test/page",
    2_000,
    1024,
    null,
  );
  assertEquals(text, "");
});

Deno.test("fetchBounded - rejects 3xx redirects without following them", async () => {
  let initSeen: RequestInit | undefined;
  const fetcher = ((_input: RequestInfo | URL, init?: RequestInit) => {
    initSeen = init;
    return Promise.resolve(
      new Response("Redirecting", {
        status: 302,
        headers: { Location: "https://evil.example/final" },
      }),
    );
  }) as typeof fetch;
  await assertRejects(
    () =>
      fetchBounded(
        fetcher,
        "https://www.youtube.com/oembed?format=json",
        2_000,
        1024,
        null,
      ),
    YouTubeMetadataError,
  );
  assertEquals(
    initSeen?.redirect,
    "manual",
    "redirects must never be followed automatically",
  );
});
