/**
 * Tests for /api/initial-data endpoint.
 * Verifies that bookmarks include tags, pagination works correctly,
 * and all data is returned for each page.
 *
 * First-page requests trigger background PDS migrations (fire-and-forget),
 * so those tests disable resource/op sanitizers.
 */

import "./test-setup.ts";

import { assertEquals, assertExists } from "@std/assert";
import { app } from "../main.ts";
import { initOAuth } from "../lib/oauth-config.ts";
import { setTestSessionProvider } from "../lib/session.ts";
import type { SessionResult } from "../lib/session.ts";

initOAuth(new Request("https://kipclip.com"));
const handler = app.handler();

const TEST_DID = "did:plc:test123";
const BOOKMARK_COLLECTION = "community.lexicon.bookmarks.bookmark";
const ANNOTATION_COLLECTION = "com.kipclip.annotation";
const TAG_COLLECTION = "com.kipclip.tag";
const PREFERENCES_COLLECTION = "com.kipclip.preferences";

function createSession(
  onRequest: (method: string, url: string, options?: any) => Response,
): SessionResult {
  return {
    session: {
      did: TEST_DID,
      pdsUrl: "https://test.pds.example",
      handle: "test.handle",
      makeRequest: (
        method: string,
        url: string,
        options?: any,
      ): Promise<Response> => {
        return Promise.resolve(onRequest(method, url, options));
      },
    } as any,
    setCookieHeader: "sid=mock; Path=/; HttpOnly",
  };
}

function bookmarkRecord(
  rkey: string,
  tags: string[],
  createdAt = "2026-01-01T00:00:00.000Z",
) {
  return {
    uri: `at://${TEST_DID}/${BOOKMARK_COLLECTION}/${rkey}`,
    cid: `cid-${rkey}`,
    value: {
      subject: `https://example.com/${rkey}`,
      createdAt,
      tags,
    },
  };
}

function annotationRecord(rkey: string) {
  return {
    uri: `at://${TEST_DID}/${ANNOTATION_COLLECTION}/${rkey}`,
    cid: `ann-cid-${rkey}`,
    value: {
      subject: `at://${TEST_DID}/${BOOKMARK_COLLECTION}/${rkey}`,
      title: `Title for ${rkey}`,
      createdAt: "2026-01-01T00:00:00.000Z",
    },
  };
}

function tagRecord(rkey: string, value: string) {
  return {
    uri: `at://${TEST_DID}/${TAG_COLLECTION}/${rkey}`,
    cid: `cid-${rkey}`,
    value: { value, createdAt: "2026-01-01T00:00:00.000Z" },
  };
}

// ---------- First page returns bookmarks with tags ----------

Deno.test({
  name: "GET /api/initial-data - first page returns bookmarks with their tags",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const bookmarks = [
      bookmarkRecord("bm1", ["swift", "ios"]),
      bookmarkRecord("bm2", ["react", "web"]),
      bookmarkRecord("bm3", []),
    ];
    const annotations = [annotationRecord("bm1"), annotationRecord("bm2")];
    const tags = [
      tagRecord("t1", "swift"),
      tagRecord("t2", "ios"),
      tagRecord("t3", "react"),
      tagRecord("t4", "web"),
    ];

    setTestSessionProvider(() =>
      Promise.resolve(
        createSession((_method, url) => {
          if (
            url.includes("listRecords") &&
            url.includes(BOOKMARK_COLLECTION)
          ) {
            return Response.json({ records: bookmarks });
          }
          if (
            url.includes("listRecords") &&
            url.includes(ANNOTATION_COLLECTION)
          ) {
            return Response.json({ records: annotations });
          }
          if (url.includes("listRecords") && url.includes(TAG_COLLECTION)) {
            return Response.json({ records: tags });
          }
          if (
            url.includes("getRecord") &&
            url.includes(PREFERENCES_COLLECTION)
          ) {
            return Response.json({}, { status: 400 });
          }
          return Response.json({});
        }),
      )
    );

    try {
      const req = new Request("https://kipclip.com/api/initial-data");
      const res = await handler(req);
      assertEquals(res.status, 200);

      const body = await res.json();

      // Verify bookmarks include tags
      assertEquals(body.bookmarks.length, 3);
      assertEquals(body.bookmarks[0].tags, ["swift", "ios"]);
      assertEquals(body.bookmarks[1].tags, ["react", "web"]);
      assertEquals(body.bookmarks[2].tags, []);

      // Verify tags are returned
      assertEquals(body.tags.length, 4);
      assertEquals(body.tags[0].value, "swift");

      // Verify enrichment from annotations
      assertEquals(body.bookmarks[0].title, "Title for bm1");
    } finally {
      setTestSessionProvider(null);
    }
  },
});

// ---------- Bookmarks with undefined tags get empty array ----------

Deno.test({
  name: "GET /api/initial-data - bookmarks without tags field get empty array",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    // Simulate old bookmark records that don't have a tags field
    const bookmarks = [{
      uri: `at://${TEST_DID}/${BOOKMARK_COLLECTION}/old1`,
      cid: "cid-old1",
      value: {
        subject: "https://example.com/old-page",
        createdAt: "2024-01-01T00:00:00.000Z",
        // No tags field — simulates pre-tag bookmarks
      },
    }];

    setTestSessionProvider(() =>
      Promise.resolve(
        createSession((_method, url) => {
          if (
            url.includes("listRecords") &&
            url.includes(BOOKMARK_COLLECTION)
          ) {
            return Response.json({ records: bookmarks });
          }
          if (url.includes("listRecords")) {
            return Response.json({ records: [] });
          }
          if (url.includes("getRecord")) {
            return Response.json({}, { status: 400 });
          }
          return Response.json({});
        }),
      )
    );

    try {
      const req = new Request("https://kipclip.com/api/initial-data");
      const res = await handler(req);
      assertEquals(res.status, 200);

      const body = await res.json();
      assertEquals(body.bookmarks.length, 1);
      // Should default to empty array, not undefined
      assertEquals(body.bookmarks[0].tags, []);
    } finally {
      setTestSessionProvider(null);
    }
  },
});

// ---------- Subsequent pages also include tags ----------

Deno.test(
  "GET /api/initial-data - subsequent pages include tags on bookmarks",
  async () => {
    const page2Bookmarks = [
      bookmarkRecord("bm101", ["2d", "art"]),
      bookmarkRecord("bm102", ["gaming"]),
    ];

    setTestSessionProvider(() =>
      Promise.resolve(
        createSession((_method, url) => {
          if (
            url.includes("listRecords") &&
            url.includes(BOOKMARK_COLLECTION)
          ) {
            return Response.json({ records: page2Bookmarks });
          }
          if (url.includes("listRecords")) {
            return Response.json({ records: [] });
          }
          return Response.json({});
        }),
      )
    );

    try {
      // Request a subsequent page (with cursor)
      const req = new Request(
        "https://kipclip.com/api/initial-data?bookmarkCursor=page2cursor",
      );
      const res = await handler(req);
      assertEquals(res.status, 200);

      const body = await res.json();
      assertEquals(body.bookmarks.length, 2);
      assertEquals(body.bookmarks[0].tags, ["2d", "art"]);
      assertEquals(body.bookmarks[1].tags, ["gaming"]);
    } finally {
      setTestSessionProvider(null);
    }
  },
);

// ---------- First page returns cursor when more pages available ----------

Deno.test({
  name: "GET /api/initial-data - returns cursor when more bookmarks exist",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const bookmarks = [bookmarkRecord("bm1", ["tag1"])];

    setTestSessionProvider(() =>
      Promise.resolve(
        createSession((_method, url) => {
          if (
            url.includes("listRecords") &&
            url.includes(BOOKMARK_COLLECTION)
          ) {
            return Response.json({
              records: bookmarks,
              cursor: "next-page-cursor",
            });
          }
          if (url.includes("listRecords")) {
            return Response.json({ records: [] });
          }
          if (url.includes("getRecord")) {
            return Response.json({}, { status: 400 });
          }
          return Response.json({});
        }),
      )
    );

    try {
      const req = new Request("https://kipclip.com/api/initial-data");
      const res = await handler(req);
      assertEquals(res.status, 200);

      const body = await res.json();
      assertExists(body.bookmarkCursor);
      assertEquals(body.bookmarkCursor, "next-page-cursor");
      assertEquals(body.bookmarks[0].tags, ["tag1"]);
    } finally {
      setTestSessionProvider(null);
    }
  },
});
