/**
 * Tests for bookmark CRUD operations.
 * Uses mock session and fetch to avoid network calls.
 */

import "./test-setup.ts";

import { assertEquals, assertExists } from "@std/assert";
import { app } from "../main.ts";
import { initOAuth } from "../lib/oauth-config.ts";
import { setTestSessionProvider } from "../lib/session.ts";
import {
  createHtmlResponse,
  createMockSessionResult,
  createPdsResponse,
  createRecordResponse,
  listRecordsResponse,
} from "./test-helpers.ts";

// Initialize OAuth with test URL
initOAuth("https://kipclip.com");
const handler = app.handler();

// Store original fetch
const originalFetch = globalThis.fetch;

// Helper to set up mock fetch for metadata extraction
function mockGlobalFetch(responses: Map<string, Response>) {
  globalThis.fetch = (
    input: RequestInfo | URL,
    _init?: RequestInit,
  ): Promise<Response> => {
    const url = typeof input === "string"
      ? input
      : input instanceof URL
      ? input.href
      : input.url;

    for (const [pattern, response] of responses) {
      if (url.includes(pattern)) {
        return Promise.resolve(response.clone());
      }
    }
    return Promise.resolve(new Response("Not Found", { status: 404 }));
  };
}

// Restore original fetch after each test
function restoreFetch() {
  globalThis.fetch = originalFetch;
}

Deno.test({
  name: "POST /api/bookmarks - creates bookmark with enriched metadata",
  async fn() {
    // Set up mock session with PDS responses
    const pdsResponses = new Map<string, Response>();
    pdsResponses.set("createRecord", createRecordResponse("abc123", "cid456"));

    setTestSessionProvider(() =>
      Promise.resolve(createMockSessionResult({ pdsResponses }))
    );

    // Mock fetch for URL metadata extraction
    mockGlobalFetch(
      new Map([
        [
          "example.com",
          createHtmlResponse({
            title: "Example Page",
            description: "A test page",
            favicon: "/icon.png",
          }),
        ],
      ]),
    );

    try {
      const req = new Request("https://kipclip.com/api/bookmarks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: "https://example.com/page" }),
      });

      const res = await handler(req);
      assertEquals(res.status, 200);

      const body = await res.json();
      assertEquals(body.success, true);
      assertExists(body.bookmark);
      assertEquals(body.bookmark.subject, "https://example.com/page");
      assertEquals(body.bookmark.title, "Example Page");
      assertEquals(body.bookmark.description, "A test page");
      assertEquals(body.bookmark.tags, []);
    } finally {
      setTestSessionProvider(null);
      restoreFetch();
    }
  },
});

Deno.test({
  name: "POST /api/bookmarks - returns 400 for missing URL",
  async fn() {
    setTestSessionProvider(() => Promise.resolve(createMockSessionResult()));

    try {
      const req = new Request("https://kipclip.com/api/bookmarks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });

      const res = await handler(req);
      assertEquals(res.status, 400);

      const body = await res.json();
      assertEquals(body.error, "URL is required");
    } finally {
      setTestSessionProvider(null);
    }
  },
});

Deno.test({
  name: "POST /api/bookmarks - returns 400 for invalid URL format",
  async fn() {
    setTestSessionProvider(() => Promise.resolve(createMockSessionResult()));

    try {
      const req = new Request("https://kipclip.com/api/bookmarks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: "not-a-valid-url" }),
      });

      const res = await handler(req);
      assertEquals(res.status, 400);

      const body = await res.json();
      assertEquals(body.error, "Invalid URL format");
    } finally {
      setTestSessionProvider(null);
    }
  },
});

Deno.test({
  name: "POST /api/bookmarks - returns 400 for non-HTTP URL",
  async fn() {
    setTestSessionProvider(() => Promise.resolve(createMockSessionResult()));

    try {
      const req = new Request("https://kipclip.com/api/bookmarks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: "ftp://example.com/file" }),
      });

      const res = await handler(req);
      assertEquals(res.status, 400);

      const body = await res.json();
      assertEquals(body.error, "Only HTTP(S) URLs are supported");
    } finally {
      setTestSessionProvider(null);
    }
  },
});

Deno.test({
  name: "GET /api/bookmarks - lists user bookmarks",
  async fn() {
    const mockBookmarks = [
      {
        uri: "at://did:plc:test123/community.lexicon.bookmarks.bookmark/abc",
        cid: "cid1",
        value: {
          subject: "https://example.com/page1",
          createdAt: "2025-01-01T00:00:00.000Z",
          tags: ["work"],
          $enriched: {
            title: "Page One",
            description: "First page",
          },
        },
      },
      {
        uri: "at://did:plc:test123/community.lexicon.bookmarks.bookmark/def",
        cid: "cid2",
        value: {
          subject: "https://example.com/page2",
          createdAt: "2025-01-02T00:00:00.000Z",
          tags: [],
          $enriched: {
            title: "Page Two",
          },
        },
      },
    ];

    const pdsResponses = new Map<string, Response>();
    pdsResponses.set("listRecords", listRecordsResponse(mockBookmarks));

    setTestSessionProvider(() =>
      Promise.resolve(createMockSessionResult({ pdsResponses }))
    );

    try {
      const req = new Request("https://kipclip.com/api/bookmarks");
      const res = await handler(req);

      assertEquals(res.status, 200);

      const body = await res.json();
      assertEquals(body.bookmarks.length, 2);
      assertEquals(body.bookmarks[0].title, "Page One");
      assertEquals(body.bookmarks[0].tags, ["work"]);
      assertEquals(body.bookmarks[1].title, "Page Two");
    } finally {
      setTestSessionProvider(null);
    }
  },
});

Deno.test({
  name: "GET /api/bookmarks - returns empty array when no bookmarks",
  async fn() {
    const pdsResponses = new Map<string, Response>();
    pdsResponses.set("listRecords", listRecordsResponse([]));

    setTestSessionProvider(() =>
      Promise.resolve(createMockSessionResult({ pdsResponses }))
    );

    try {
      const req = new Request("https://kipclip.com/api/bookmarks");
      const res = await handler(req);

      assertEquals(res.status, 200);

      const body = await res.json();
      assertEquals(body.bookmarks, []);
    } finally {
      setTestSessionProvider(null);
    }
  },
});

Deno.test({
  name: "DELETE /api/bookmarks/:rkey - deletes bookmark",
  async fn() {
    const pdsResponses = new Map<string, Response>();
    pdsResponses.set("deleteRecord", createPdsResponse({ success: true }));

    setTestSessionProvider(() =>
      Promise.resolve(createMockSessionResult({ pdsResponses }))
    );

    try {
      const req = new Request("https://kipclip.com/api/bookmarks/abc123", {
        method: "DELETE",
      });

      const res = await handler(req);
      assertEquals(res.status, 200);

      const body = await res.json();
      assertEquals(body.success, true);
    } finally {
      setTestSessionProvider(null);
    }
  },
});

Deno.test({
  name: "PATCH /api/bookmarks/:rkey - updates bookmark tags",
  async fn() {
    const existingRecord = {
      uri: "at://did:plc:test123/community.lexicon.bookmarks.bookmark/abc",
      cid: "cid1",
      value: {
        subject: "https://example.com/page",
        createdAt: "2025-01-01T00:00:00.000Z",
        tags: [],
        $enriched: {
          title: "Original Title",
          description: "Original description",
        },
      },
    };

    const pdsResponses = new Map<string, Response>();
    pdsResponses.set("getRecord", createPdsResponse(existingRecord));
    pdsResponses.set(
      "putRecord",
      createPdsResponse({
        uri: existingRecord.uri,
        cid: "newcid",
      }),
    );

    setTestSessionProvider(() =>
      Promise.resolve(createMockSessionResult({ pdsResponses }))
    );

    try {
      const req = new Request("https://kipclip.com/api/bookmarks/abc", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tags: ["work", "important"] }),
      });

      const res = await handler(req);
      assertEquals(res.status, 200);

      const body = await res.json();
      assertEquals(body.success, true);
      assertEquals(body.bookmark.tags, ["work", "important"]);
    } finally {
      setTestSessionProvider(null);
    }
  },
});

Deno.test({
  name: "PATCH /api/bookmarks/:rkey - returns 400 for invalid tags",
  async fn() {
    setTestSessionProvider(() => Promise.resolve(createMockSessionResult()));

    try {
      const req = new Request("https://kipclip.com/api/bookmarks/abc", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tags: "not-an-array" }),
      });

      const res = await handler(req);
      assertEquals(res.status, 400);

      const body = await res.json();
      assertEquals(body.error, "Tags must be an array");
    } finally {
      setTestSessionProvider(null);
    }
  },
});

Deno.test({
  name: "POST /api/bookmarks - handles PDS error gracefully",
  async fn() {
    const pdsResponses = new Map<string, Response>();
    pdsResponses.set(
      "createRecord",
      new Response("Internal Server Error", { status: 500 }),
    );

    setTestSessionProvider(() =>
      Promise.resolve(createMockSessionResult({ pdsResponses }))
    );

    // Mock fetch for metadata (still needs to work)
    mockGlobalFetch(
      new Map([
        ["example.com", createHtmlResponse({ title: "Test" })],
      ]),
    );

    try {
      const req = new Request("https://kipclip.com/api/bookmarks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: "https://example.com/page" }),
      });

      const res = await handler(req);
      assertEquals(res.status, 500);

      const body = await res.json();
      assertExists(body.error);
    } finally {
      setTestSessionProvider(null);
      restoreFetch();
    }
  },
});
