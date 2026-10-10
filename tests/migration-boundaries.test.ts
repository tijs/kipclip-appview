import "../runtime/deno/install.ts";
import "./test-setup.ts";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { app } from "../main.ts";
import { encodeTagsForUrl } from "../shared/utils.ts";
import { createPlcResponse } from "./test-helpers.ts";
import {
  assertIsolated,
  assertSecurity,
  loopbackInfo,
  withMockFetch,
} from "./migration/isolation.ts";

assertIsolated();
const handler = app.handler();
const origin = "https://migration.example";

Deno.test("migration uncaught route error is captured before baseline 500 handler and bypasses security unwinding", async () => {
  const readText = Deno.readTextFile;
  const errorLog = console.error;
  const logs: any[][] = [];
  const failure = new Error("fixture template read failure");
  Deno.readTextFile = ((path, options) => {
    if (String(path).endsWith("/frontend/index.html")) {
      return Promise.reject(failure);
    }
    return readText(path, options);
  }) as typeof Deno.readTextFile;
  console.error = (...args) => logs.push(args);
  try {
    const res = await handler(new Request(`${origin}/migration-error-page`));
    assertEquals(res.status, 500);
    assertEquals(await res.text(), "Internal server error");
    assertEquals(res.headers.get("x-frame-options"), null);
    const capture = logs.find((args) => args[0] === "[Error]");
    assert(capture, "Error-capture middleware must run");
    assertEquals(capture[1], failure);
    assertEquals(capture[2], {
      url: `${origin}/migration-error-page`,
      method: "GET",
    });
    assertEquals(logs.filter((args) => args[0] === "[Error]").length, 1);
  } finally {
    Deno.readTextFile = readText;
    console.error = errorLog;
  }
});

Deno.test("migration webhook socket-peer IP cannot be spoofed via forwarded IP/host", async () => {
  const res = await handler(
    new Request("http://127.0.0.1:8888/api/sync/hook", {
      method: "POST",
      body: "bad json that must not reach route",
      headers: {
        "x-forwarded-for": "127.0.0.1",
        "x-real-ip": "127.0.0.1",
        "x-forwarded-host": "localhost",
        "x-forwarded-proto": "https",
      },
    }),
    loopbackInfo("203.0.113.42"),
  );
  assertEquals(res.status, 403);
  assertEquals(await res.text(), "Forbidden");
  assertSecurity(res);
  // The reverse case: actual loopback peer is allowed despite external XFF.
  const allowed = await handler(
    new Request(`${origin}/api/sync/hook`, {
      method: "POST",
      body: JSON.stringify({ type: "unknown" }),
      headers: { "x-forwarded-for": "203.0.113.42" },
    }),
    loopbackInfo(),
  );
  assertEquals(allowed.status, 200);
  assertEquals(await allowed.json(), { type: "unknown", applied: false });
  assertSecurity(allowed);
});

Deno.test("migration security stack covers explicit 401/404/redirect and framework error bypass", async () => {
  for (const path of ["/api/bookmarks", "/api/no-route", "/login"]) {
    const res = await handler(new Request(`${origin}${path}`));
    assertEquals(
      res.status,
      path === "/api/bookmarks" ? 401 : path === "/login" ? 400 : 404,
    );
    assertSecurity(res);
    await res.body?.cancel();
  }
  const error = await handler(
    new Request(`${origin}/api/bookmarks`, { method: "PUT" }),
  );
  assertEquals(error.status, 405);
  assertEquals(await error.text(), "Method Not Allowed");
  assertEquals(error.headers.get("x-frame-options"), null);
});

for (
  const [form, location] of [
    [
      {
        url: "https://example.com/a?q=1&b=2",
        title: "Title & name",
        text: "note",
      },
      `${origin}/save?url=https%3A%2F%2Fexample.com%2Fa%3Fq%3D1%26b%3D2&title=Title+%26+name&text=note`,
    ],
    [
      { text: "See https://example.com/shared next" },
      `${origin}/save?url=https%3A%2F%2Fexample.com%2Fshared`,
    ],
    [{ text: "no URL" }, "/"],
  ]
) {
  Deno.test(`migration share-target form redirect ${JSON.stringify(form)}`, async () => {
    const res = await handler(
      new Request(`${origin}/share-target`, {
        method: "POST",
        body: new URLSearchParams(form),
      }),
    );
    assertEquals(res.status, 303);
    assertEquals(res.headers.get("location"), location);
    assertEquals(await res.text(), "");
    assertSecurity(res);
  });
}

Deno.test("migration share-target malformed body + forwarded host preserves raw Request redirect origin", async () => {
  const invalid = await handler(
    new Request(`${origin}/share-target`, {
      method: "POST",
      body: "not form data",
    }),
  );
  assertEquals(invalid.status, 303);
  assertEquals(invalid.headers.get("location"), "/");
  const res = await handler(
    new Request("http://127.0.0.1:8888/share-target", {
      method: "POST",
      body: new URLSearchParams({ url: "https://example.com" }),
      headers: {
        "x-forwarded-proto": "https",
        "x-forwarded-host": "public.example",
      },
    }),
  );
  assertEquals(res.status, 303);
  assertEquals(
    res.headers.get("location"),
    "http://127.0.0.1:8888/save?url=https%3A%2F%2Fexample.com",
  );
  assertSecurity(res);
});

for (
  const [body, headers, status] of [
    ["invalid json", {}, 400],
    ["null", {}, 400],
    ["{}", {}, 204],
    ["{}", { "content-length": "4097" }, 413],
    ["x".repeat(4097), {}, 413],
  ] as const
) {
  Deno.test(`migration metrics validation status ${status} / bytes ${body.length}`, async () => {
    const res = await handler(
      new Request(`${origin}/api/metrics`, { method: "POST", body, headers }),
    );
    assertEquals(res.status, status);
    assertEquals(await res.text(), "");
    assertSecurity(res);
  });
}

Deno.test("migration metrics log side effect prunes/sanitizes/caps inputs", async () => {
  const saved = console.log;
  const lines: any[][] = [];
  console.log = (...args) => lines.push(args);
  try {
    const res = await handler(
      new Request(`${origin}/api/metrics`, {
        method: "POST",
        headers: { "user-agent": "x".repeat(150) },
        body: JSON.stringify({
          entries: { okay: 1.234, bad: -1, string: "bad" },
          vitals: { lcp: 3.456 },
          bookmarks: 47,
          visibility: "pagehide",
          release: "fixture",
        }),
      }),
    );
    assertEquals(res.status, 204);
    assertEquals(lines.length, 1);
    assertEquals(lines[0][0], "[perf]");
    assertEquals(JSON.parse(lines[0][1]), {
      kind: "perf",
      visibility: "pagehide",
      release: "fixture",
      bookmarks: 47,
      entries: { okay: 1.2 },
      vitals: { lcp: 3.5 },
      ua: "x".repeat(120),
    });
  } finally {
    console.log = saved;
  }
});

Deno.test("migration CSP report logs capped raw body and always 204", async () => {
  const saved = console.warn;
  const lines: any[][] = [];
  console.warn = (...args) => lines.push(args);
  try {
    for (
      const text of [
        '{"csp-report":{"blocked-uri":"fixture.example"}}',
        "x".repeat(4200),
      ]
    ) {
      const res = await handler(
        new Request(`${origin}/api/csp-report`, { method: "POST", body: text }),
      );
      assertEquals(res.status, 204);
      assertEquals(await res.text(), "");
      assertSecurity(res);
    }
    assertEquals(lines, [[
      "[csp-report]",
      '{"csp-report":{"blocked-uri":"fixture.example"}}',
    ], ["[csp-report]", "x".repeat(4096) + "...[truncated]"]]);
  } finally {
    console.warn = saved;
  }
});

Deno.test("migration secondary public proxy response/cache and hydration", async () => {
  await withMockFetch((request) => {
    const url = new URL(request.url);
    if (url.hostname === "atstore.fyi") {
      return Response.json({
        reviews: [{
          id: "fixture-review",
          authorDid: "did:plc:reader",
          authorHandle: "reader.example",
          rating: 5,
          text: "Fixture review",
          reviewCreatedAt: "2026-01-01T00:00:00Z",
        }],
      });
    }
    if (url.hostname === "constellation.microcosm.blue") {
      return Response.json({
        linking_records: [{
          did: "did:plc:reader",
          collection: "app.bsky.feed.post",
          rkey: "fixture-post",
        }],
      });
    }
    if (url.pathname.endsWith("getPosts")) {
      return Response.json({
        posts: [{
          uri: "at://did:plc:reader/app.bsky.feed.post/fixture-post",
          cid: "fixture-cid",
          author: { did: "did:plc:reader", handle: "reader.example" },
          record: {
            text: "A fixture mention long enough to pass forty characters.",
          },
          indexedAt: "2026-01-01T00:00:00Z",
          likeCount: 2,
        }],
      });
    }
    if (url.hostname === "atprotofans.com") {
      return Response.json({
        supporters: [{ did: "did:plc:reader", handle: "old.example" }],
      });
    }
    if (url.pathname.endsWith("getProfiles")) {
      return Response.json({
        profiles: [{ did: "did:plc:reader", handle: "reader.example" }],
      });
    }
    throw new Error(`Unexpected public proxy URL ${url}`);
  }, async (calls) => {
    for (
      const [path, expected] of [
        ["reviews", {
          reviews: [{
            id: "fixture-review",
            handle: "reader.example",
            displayName: "reader.example",
            avatar: null,
            text: "Fixture review",
            rating: 5,
            createdAt: "2026-01-01T00:00:00Z",
            atstoreUrl: "https://atstore.fyi/products/kipclip",
          }],
          stale: false,
        }],
        ["mentions", {
          mentions: [{
            uri: "at://did:plc:reader/app.bsky.feed.post/fixture-post",
            cid: "fixture-cid",
            handle: "reader.example",
            displayName: "reader.example",
            avatar: null,
            text: "A fixture mention long enough to pass forty characters.",
            indexedAt: "2026-01-01T00:00:00Z",
            likeCount: 2,
            replyCount: 0,
            repostCount: 0,
          }],
          stale: false,
        }],
        ["supporters", {
          supporters: [{
            did: "did:plc:reader",
            handle: "reader.example",
            displayName: "old.example",
            avatar: null,
          }],
          totalCount: 1,
          stale: false,
        }],
      ] as const
    ) {
      const res = await handler(new Request(`${origin}/api/${path}`));
      assertEquals(res.status, 200);
      assertEquals(
        res.headers.get("cache-control"),
        "public, max-age=60, stale-while-revalidate=600",
      );
      assertSecurity(res);
      assertEquals(await res.json(), expected);
      const count = calls.length;
      assertEquals(
        await (await handler(new Request(`${origin}/api/${path}`))).json(),
        expected,
      );
      assertEquals(
        calls.length,
        count,
        "Second request uses 24h in-process cache",
      );
    }
    assertEquals(calls.length, 5);
  });
});

Deno.test("migration RSS route validates DID/tags/resolution without external calls", async () => {
  const encoded = encodeTagsForUrl(["news"]);
  await withMockFetch(
    () => new Response(null, { status: 404 }),
    async (calls) => {
      const badDid = await handler(
        new Request(`${origin}/share/bad-did/${encoded}/rss`),
      );
      assertEquals(badDid.status, 400);
      assertEquals(await badDid.text(), "Invalid DID");
      const badTags = await handler(
        new Request(`${origin}/share/did:plc:fixture/%25%25%25/rss`),
      );
      // Decoder throws; the route's outer catch currently returns 500, not 400.
      assertEquals(badTags.status, 500);
      assertEquals(await badTags.text(), "Failed to generate feed");
      assertEquals(calls.length, 0);
      const missing = await handler(
        new Request(`${origin}/share/did:plc:fixture/${encoded}/rss`),
      );
      assertEquals(missing.status, 404);
      assertEquals(await missing.text(), "PDS not found");
      assertSecurity(missing);
      assertEquals(calls.length, 1);
    },
  );
});

Deno.test("migration RSS successful route XML escaping/tag filtering/annotation/sorting/cache", async () => {
  const did = "did:plc:rssfixture";
  const encoded = encodeTagsForUrl(["news"]);
  const collection = "community.lexicon.bookmarks.bookmark";
  await withMockFetch((request) => {
    const url = new URL(request.url);
    if (url.hostname === "plc.directory") {
      return createPlcResponse({
        did,
        pdsUrl: "https://fixture.pds.example",
        handle: "alice.example",
      });
    }
    assertEquals(url.hostname, "fixture.pds.example");
    const requested = url.searchParams.get("collection");
    if (requested === collection) {
      return Response.json({
        records: [
          {
            uri: `at://${did}/${collection}/older`,
            value: {
              subject: "https://example.com/older",
              tags: ["news"],
              createdAt: "2026-01-01T00:00:00Z",
            },
          },
          {
            uri: `at://${did}/${collection}/newer`,
            value: {
              subject: "https://example.com/?a=1&b=2",
              tags: ["news"],
              createdAt: "2026-01-02T00:00:00Z",
            },
          },
          {
            uri: `at://${did}/${collection}/hidden`,
            value: {
              subject: "https://example.com/hidden",
              tags: ["other"],
              createdAt: "2026-01-03T00:00:00Z",
            },
          },
        ],
      });
    }
    assertEquals(requested, "com.kipclip.annotation");
    return Response.json({
      records: [{
        uri: `at://${did}/com.kipclip.annotation/newer`,
        value: {
          title: '<Title & "fixture">',
          description: "Reader's description",
        },
      }],
    });
  }, async (calls) => {
    const res = await handler(
      new Request(`${origin}/share/${did}/${encoded}/rss`),
    );
    assertEquals(res.status, 200);
    assertEquals(
      res.headers.get("content-type"),
      "application/rss+xml; charset=utf-8",
    );
    assertEquals(
      res.headers.get("cache-control"),
      "public, max-age=60, stale-while-revalidate=600",
    );
    assertSecurity(res);
    const xml = await res.text();
    assertStringIncludes(xml, "&lt;Title &amp; &quot;fixture&quot;&gt;");
    assertStringIncludes(xml, "Reader&apos;s description");
    assertStringIncludes(xml, "https://example.com/?a=1&amp;b=2");
    assertStringIncludes(xml, "Fri, 02 Jan 2026 00:00:00 GMT");
    assert(xml.indexOf("/newer</guid>") < xml.indexOf("/older</guid>"));
    assert(!xml.includes("example.com/hidden"));
    assertEquals(calls.length, 3);
  });
});
