/**
 * Regression tests for the public share endpoint.
 *
 * The share endpoint has to paginate through the user's full bookmark
 * collection — users may have thousands of records, and matches for a
 * given tag may not appear in the most recent 100.
 */

import "./test-setup.ts";

import { assertEquals } from "@std/assert";

import { app } from "../main.ts";
import { initOAuth } from "../lib/oauth-config.ts";
import { encodeTagsForUrl } from "../shared/utils.ts";

initOAuth(new Request("https://kipclip.com"));
const handler = app.handler();

const TEST_DID = "did:plc:sharetest";
const TEST_PDS = "https://test.pds.example";
const TEST_HANDLE = "sharer.test";

interface BookmarkFixture {
  rkey: string;
  subject: string;
  tags: string[];
  createdAt?: string;
}

function bookmarkRecord(fx: BookmarkFixture) {
  return {
    uri: `at://${TEST_DID}/community.lexicon.bookmarks.bookmark/${fx.rkey}`,
    cid: `cid-${fx.rkey}`,
    value: {
      $type: "community.lexicon.bookmarks.bookmark",
      subject: fx.subject,
      tags: fx.tags,
      createdAt: fx.createdAt ?? "2025-01-01T00:00:00Z",
    },
  };
}

/**
 * Install a fetch stub that simulates a PDS with paginated listRecords.
 * Returns a cleanup function.
 */
function installPdsStub(
  bookmarks: BookmarkFixture[],
  opts: { pageSize?: number; annotations?: Map<string, unknown> } = {},
): () => void {
  const pageSize = opts.pageSize ?? 100;
  const annotations = opts.annotations ?? new Map();
  const originalFetch = globalThis.fetch;

  globalThis.fetch = ((input: RequestInfo | URL, _init?: RequestInit) => {
    const url = typeof input === "string"
      ? input
      : input instanceof URL
      ? input.href
      : input.url;

    // PLC directory
    if (url.startsWith("https://plc.directory/")) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            id: TEST_DID,
            alsoKnownAs: [`at://${TEST_HANDLE}`],
            service: [
              {
                id: "#atproto_pds",
                type: "AtprotoPersonalDataServer",
                serviceEndpoint: TEST_PDS,
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
    }

    if (url.includes("/xrpc/com.atproto.repo.listRecords")) {
      const parsed = new URL(url);
      const collection = parsed.searchParams.get("collection");
      const cursor = parsed.searchParams.get("cursor");

      if (collection === "community.lexicon.bookmarks.bookmark") {
        const startIdx = cursor ? parseInt(cursor, 10) : 0;
        const page = bookmarks.slice(startIdx, startIdx + pageSize);
        const nextIdx = startIdx + pageSize;
        const nextCursor = nextIdx < bookmarks.length
          ? String(nextIdx)
          : undefined;
        return Promise.resolve(
          new Response(
            JSON.stringify({
              records: page.map(bookmarkRecord),
              cursor: nextCursor,
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
        );
      }

      return Promise.resolve(
        new Response(JSON.stringify({ records: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    }

    if (url.includes("/xrpc/com.atproto.repo.getRecord")) {
      const parsed = new URL(url);
      const collection = parsed.searchParams.get("collection");
      const rkey = parsed.searchParams.get("rkey") ?? "";
      if (collection === "com.kipclip.annotation" && annotations.has(rkey)) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              uri: `at://${TEST_DID}/com.kipclip.annotation/${rkey}`,
              cid: `ann-cid-${rkey}`,
              value: annotations.get(rkey),
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
        );
      }
      return Promise.resolve(new Response("not found", { status: 404 }));
    }

    return Promise.resolve(new Response("unexpected", { status: 500 }));
  }) as typeof fetch;

  return () => {
    globalThis.fetch = originalFetch;
  };
}

Deno.test("GET /api/share - finds matching bookmarks beyond the first page", async () => {
  // Build 250 bookmarks. Only two (well past page 1) are tagged "accessibility".
  const bookmarks: BookmarkFixture[] = [];
  for (let i = 0; i < 250; i++) {
    bookmarks.push({
      rkey: `rk${i.toString().padStart(3, "0")}`,
      subject: `https://example.com/post-${i}`,
      tags: i === 150 || i === 220 ? ["accessibility"] : ["other"],
    });
  }

  const restore = installPdsStub(bookmarks, { pageSize: 100 });
  try {
    const encoded = encodeTagsForUrl(["accessibility"]);
    const req = new Request(
      `https://kipclip.com/api/share/${TEST_DID}/${encoded}`,
    );
    const res = await handler(req);
    assertEquals(res.status, 200);

    const body = await res.json();
    assertEquals(body.handle, TEST_HANDLE);
    assertEquals(body.tags, ["accessibility"]);
    assertEquals(body.bookmarks.length, 2);
    const subjects = body.bookmarks.map((b: { subject: string }) => b.subject)
      .sort();
    assertEquals(subjects, [
      "https://example.com/post-150",
      "https://example.com/post-220",
    ]);
  } finally {
    restore();
  }
});

Deno.test("GET /api/share - returns empty list when no bookmarks match", async () => {
  const bookmarks: BookmarkFixture[] = [
    { rkey: "a", subject: "https://example.com/a", tags: ["other"] },
    { rkey: "b", subject: "https://example.com/b", tags: [] },
  ];

  const restore = installPdsStub(bookmarks);
  try {
    const encoded = encodeTagsForUrl(["accessibility"]);
    const req = new Request(
      `https://kipclip.com/api/share/${TEST_DID}/${encoded}`,
    );
    const res = await handler(req);
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.bookmarks, []);
    assertEquals(body.handle, TEST_HANDLE);
  } finally {
    restore();
  }
});

Deno.test("GET /api/share - merges annotation metadata for matched bookmarks", async () => {
  const bookmarks: BookmarkFixture[] = [
    {
      rkey: "match1",
      subject: "https://example.com/1",
      tags: ["accessibility"],
    },
    { rkey: "skip", subject: "https://example.com/2", tags: ["other"] },
  ];
  const annotations = new Map<string, unknown>([
    ["match1", {
      subject: `at://${TEST_DID}/community.lexicon.bookmarks.bookmark/match1`,
      title: "Accessibility Guide",
      description: "How to build accessible apps",
      favicon: "https://example.com/fav.ico",
      createdAt: "2025-01-01T00:00:00Z",
    }],
  ]);

  const restore = installPdsStub(bookmarks, { annotations });
  try {
    const encoded = encodeTagsForUrl(["accessibility"]);
    const req = new Request(
      `https://kipclip.com/api/share/${TEST_DID}/${encoded}`,
    );
    const res = await handler(req);
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.bookmarks.length, 1);
    assertEquals(body.bookmarks[0].title, "Accessibility Guide");
    assertEquals(
      body.bookmarks[0].description,
      "How to build accessible apps",
    );
    assertEquals(body.bookmarks[0].favicon, "https://example.com/fav.ico");
  } finally {
    restore();
  }
});

Deno.test("GET /api/share - rejects invalid DID format", async () => {
  const encoded = encodeTagsForUrl(["accessibility"]);
  for (const badDid of ["not-a-did", "did:foo:bar", "did:plc:", "did:"]) {
    const req = new Request(
      `https://kipclip.com/api/share/${badDid}/${encoded}`,
    );
    const res = await handler(req);
    assertEquals(
      res.status,
      400,
      `expected 400 for DID "${badDid}", got ${res.status}`,
    );
  }
});

Deno.test("GET /api/share - rejects loopback PDS (SSRF)", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith("https://plc.directory/")) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            id: TEST_DID,
            alsoKnownAs: [`at://${TEST_HANDLE}`],
            service: [{
              id: "#atproto_pds",
              type: "AtprotoPersonalDataServer",
              serviceEndpoint: "https://127.0.0.1:8080",
            }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
    }
    return Promise.resolve(
      new Response("should not be called", { status: 500 }),
    );
  }) as typeof fetch;

  try {
    const encoded = encodeTagsForUrl(["accessibility"]);
    const req = new Request(
      `https://kipclip.com/api/share/${TEST_DID}/${encoded}`,
    );
    const res = await handler(req);
    assertEquals(res.status, 400);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("GET /api/share - rejects non-https PDS (SSRF)", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith("https://plc.directory/")) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            id: TEST_DID,
            alsoKnownAs: [`at://${TEST_HANDLE}`],
            service: [{
              id: "#atproto_pds",
              type: "AtprotoPersonalDataServer",
              serviceEndpoint: "http://example.com",
            }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
    }
    return Promise.resolve(
      new Response("should not be called", { status: 500 }),
    );
  }) as typeof fetch;

  try {
    const encoded = encodeTagsForUrl(["accessibility"]);
    const req = new Request(
      `https://kipclip.com/api/share/${TEST_DID}/${encoded}`,
    );
    const res = await handler(req);
    assertEquals(res.status, 400);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("GET /api/share - hostile PDS with non-advancing cursor is bounded", async () => {
  // PDS that always returns 100 records with the same cursor. Without the
  // cursor-advance check this would spin until the isolate died.
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith("https://plc.directory/")) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            id: TEST_DID,
            alsoKnownAs: [`at://${TEST_HANDLE}`],
            service: [{
              id: "#atproto_pds",
              type: "AtprotoPersonalDataServer",
              serviceEndpoint: TEST_PDS,
            }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
    }
    if (url.includes("/xrpc/com.atproto.repo.listRecords")) {
      calls++;
      const records = Array.from({ length: 100 }, (_, i) => ({
        uri: `at://${TEST_DID}/community.lexicon.bookmarks.bookmark/rk${i}`,
        cid: `cid${i}`,
        value: {
          $type: "community.lexicon.bookmarks.bookmark",
          subject: `https://example.com/${i}`,
          tags: [],
          createdAt: "2025-01-01T00:00:00Z",
        },
      }));
      return Promise.resolve(
        new Response(
          JSON.stringify({ records, cursor: "stuck" }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
    }
    return Promise.resolve(new Response("unexpected", { status: 500 }));
  }) as typeof fetch;

  try {
    const encoded = encodeTagsForUrl(["accessibility"]);
    const req = new Request(
      `https://kipclip.com/api/share/${TEST_DID}/${encoded}`,
    );
    const res = await handler(req);
    assertEquals(res.status, 200);
    // Non-advancing cursor means we should stop after the second page at most.
    if (calls > 3) {
      throw new Error(`paginator did not bound itself: ${calls} calls`);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});
