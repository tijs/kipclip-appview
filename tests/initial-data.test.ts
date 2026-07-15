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
import { _resetPdsMigrationCache } from "../lib/pds-migration-guard.ts";

const appUrl = URL.parse("https://kipclip.com");
if (!appUrl) throw new Error("Invalid test app URL");
initOAuth(appUrl);
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

function stubCurrentPds(pdsUrl: string): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (() =>
    Promise.resolve(
      Response.json({
        service: [{
          id: "#atproto_pds",
          type: "AtprotoPersonalDataServer",
          serviceEndpoint: pdsUrl,
        }],
      }),
    )) as typeof globalThis.fetch;
  return () => {
    globalThis.fetch = original;
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

// ---------- First page returns bookmarks with tags ----------

Deno.test({
  name:
    "GET /api/initial-data - first page returns bookmarks with their tag arrays and no top-level tags field",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const bookmarks = [
      bookmarkRecord("bm1", ["swift", "ios"]),
      bookmarkRecord("bm2", ["react", "web"]),
      bookmarkRecord("bm3", []),
    ];
    const annotations = [annotationRecord("bm1"), annotationRecord("bm2")];

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
            // Migration path may still pull tags; handler should not include
            // them in the response.
            return Response.json({ records: [] });
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

      // Per-bookmark tag arrays still present
      assertEquals(body.bookmarks.length, 3);
      assertEquals(body.bookmarks[0].tags, ["swift", "ios"]);
      assertEquals(body.bookmarks[1].tags, ["react", "web"]);
      assertEquals(body.bookmarks[2].tags, []);

      // Top-level tags field removed — clients fetch /api/tags separately
      assertEquals(body.tags, undefined);

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

// ---------- Missing PDS repo gets a helpful error ----------

Deno.test({
  name: "GET /api/initial-data - reports an unavailable canonical PDS repo",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    _resetPdsMigrationCache();
    const restoreFetch = stubCurrentPds("https://test.pds.example");
    setTestSessionProvider(() =>
      Promise.resolve(
        createSession((_method, url) => {
          if (url.includes("listRecords")) {
            return Response.json(
              {
                error: "InvalidRequest",
                message: `Could not find repo: ${TEST_DID}`,
              },
              { status: 400 },
            );
          }
          return Response.json({});
        }),
      )
    );

    try {
      const res = await handler(
        new Request("https://kipclip.com/api/initial-data"),
      );
      assertEquals(res.status, 503);
      assertEquals(await res.json(), {
        error:
          "Your account's data server is unavailable. Try again later. If this keeps happening, contact your account provider.",
      });
    } finally {
      restoreFetch();
      setTestSessionProvider(null);
    }
  },
});

Deno.test({
  name: "GET /api/initial-data - stale PDS session forces reauthentication",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    _resetPdsMigrationCache();
    const restoreFetch = stubCurrentPds("https://new.pds.example");
    setTestSessionProvider(() =>
      Promise.resolve(
        createSession((_method, url) => {
          if (url.includes("listRecords")) {
            return Response.json(
              { error: "RepoNotFound", message: "Repository not found" },
              { status: 404 },
            );
          }
          return Response.json({});
        }),
      )
    );

    try {
      const res = await handler(
        new Request("https://kipclip.com/api/initial-data"),
      );
      assertEquals(res.status, 401);
      assertEquals(await res.json(), {
        error: "Authentication required",
        message:
          "You moved your account to a new server. Please sign in again to keep saving.",
        code: "PDS_MIGRATED",
      });
    } finally {
      restoreFetch();
      setTestSessionProvider(null);
    }
  },
});

Deno.test({
  name:
    "GET /api/initial-data - unrelated and oversized PDS errors remain empty results",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    try {
      for (
        const { body, status } of [
          {
            body: { error: "InvalidRequest", message: "Invalid cursor" },
            status: 400,
          },
          {
            body: { error: "RepoNotFoundish", message: "Could not find repo" },
            status: 404,
          },
          {
            body: { error: "RepoNotFound", padding: "x".repeat(5000) },
            status: 400,
          },
        ]
      ) {
        setTestSessionProvider(() =>
          Promise.resolve(
            createSession((_method, url) =>
              url.includes("listRecords")
                ? Response.json(body, { status })
                : Response.json({})
            ),
          )
        );
        const res = await handler(
          new Request("https://kipclip.com/api/initial-data"),
        );
        assertEquals(res.status, 200);
        const result = await res.json();
        assertEquals(result.bookmarks, []);
      }
    } finally {
      setTestSessionProvider(null);
    }
  },
});

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
