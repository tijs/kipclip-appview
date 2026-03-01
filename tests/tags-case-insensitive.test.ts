/**
 * Integration tests for case-insensitive tag behavior.
 * Tests that tag operations properly handle mixed-case tags.
 */

import "./test-setup.ts";

import { assertEquals } from "@std/assert";
import { app } from "../main.ts";
import { initOAuth } from "../lib/oauth-config.ts";
import { setTestSessionProvider } from "../lib/session.ts";
import type { SessionResult } from "../lib/session.ts";

initOAuth(new Request("https://kipclip.com"));
const handler = app.handler();

const TEST_DID = "did:plc:test123";
const BOOKMARK_COLLECTION = "community.lexicon.bookmarks.bookmark";
const TAG_COLLECTION = "com.kipclip.tag";

function tagRequest(method: string, path: string, body?: unknown): Request {
  const opts: RequestInit = { method };
  if (body) {
    opts.headers = { "Content-Type": "application/json" };
    opts.body = JSON.stringify(body);
  }
  return new Request(`https://kipclip.com${path}`, opts);
}

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

function tagRecord(rkey: string, value: string, createdAt?: string) {
  return {
    uri: `at://${TEST_DID}/${TAG_COLLECTION}/${rkey}`,
    cid: `cid-${rkey}`,
    value: { value, createdAt: createdAt || "2026-01-01T00:00:00.000Z" },
  };
}

function bookmarkRecord(rkey: string, tags: string[]) {
  return {
    uri: `at://${TEST_DID}/${BOOKMARK_COLLECTION}/${rkey}`,
    cid: `cid-${rkey}`,
    value: {
      subject: `https://example.com/${rkey}`,
      createdAt: "2026-01-01T00:00:00.000Z",
      tags,
    },
  };
}

// ---------- POST /api/tags — returns existing on case-insensitive match ----------

Deno.test("POST /api/tags - returns existing tag on case-insensitive match", async () => {
  const existingTag = tagRecord("tag1", "Swift");

  setTestSessionProvider(() =>
    Promise.resolve(
      createSession((_method, url) => {
        if (url.includes("listRecords")) {
          return Response.json({ records: [existingTag] });
        }
        return Response.json({});
      }),
    )
  );

  const res = await handler(
    tagRequest("POST", "/api/tags", { value: "swift" }),
  );
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.success, true);
  // Should return the existing tag with original casing
  assertEquals(body.tag.value, "Swift");
  assertEquals(body.tag.uri, existingTag.uri);
});

Deno.test("POST /api/tags - creates new tag when no match", async () => {
  const existingTag = tagRecord("tag1", "Swift");
  let createCalled = false;

  setTestSessionProvider(() =>
    Promise.resolve(
      createSession((_method, url, options) => {
        if (url.includes("listRecords")) {
          return Response.json({ records: [existingTag] });
        }
        if (url.includes("createRecord")) {
          createCalled = true;
          const body = JSON.parse(options?.body);
          return Response.json({
            uri: `at://${TEST_DID}/${TAG_COLLECTION}/newtag`,
            cid: "cid-new",
            value: body.record,
          });
        }
        return Response.json({});
      }),
    )
  );

  const res = await handler(tagRequest("POST", "/api/tags", { value: "Rust" }));
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.success, true);
  assertEquals(body.tag.value, "Rust");
  assertEquals(createCalled, true);
});

// ---------- PUT /api/tags/:rkey — collision detection ----------

Deno.test("PUT /api/tags/:rkey - returns 409 on case-insensitive collision", async () => {
  const currentTag = tagRecord("tag1", "swift");
  const otherTag = tagRecord("tag2", "Swift");

  setTestSessionProvider(() =>
    Promise.resolve(
      createSession((_method, url) => {
        if (url.includes("getRecord")) {
          return Response.json(currentTag);
        }
        if (url.includes("listRecords")) {
          return Response.json({ records: [currentTag, otherTag] });
        }
        return Response.json({});
      }),
    )
  );

  const res = await handler(
    tagRequest("PUT", "/api/tags/tag1", { value: "SWIFT" }),
  );
  assertEquals(res.status, 409);
  const body = await res.json();
  assertEquals(body.error, 'A tag "Swift" already exists');
});

Deno.test("PUT /api/tags/:rkey - allows case-only rename of same tag", async () => {
  const currentTag = tagRecord("tag1", "swift");
  const putCalls: any[] = [];

  setTestSessionProvider(() =>
    Promise.resolve(
      createSession((_method, url, options) => {
        if (url.includes("getRecord")) {
          return Response.json(currentTag);
        }
        if (url.includes("listRecords")) {
          // Only one tag (the current one) — no collision
          return Response.json({ records: [currentTag] });
        }
        if (url.includes("putRecord")) {
          putCalls.push(JSON.parse(options?.body));
          return Response.json({
            uri: currentTag.uri,
            cid: "cid-updated",
          });
        }
        return Response.json({});
      }),
    )
  );

  const res = await handler(
    tagRequest("PUT", "/api/tags/tag1", { value: "Swift" }),
  );
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.success, true);
  assertEquals(body.tag.value, "Swift");
});

// ---------- Bulk add-tags — case-insensitive ----------

Deno.test("bulk add-tags - skips tags already present case-insensitively", async () => {
  const bookmark = bookmarkRecord("bk1", ["Swift"]);
  const putCalls: any[] = [];

  setTestSessionProvider(() =>
    Promise.resolve(
      createSession((_method, url, options) => {
        if (url.includes("getRecord") && url.includes(BOOKMARK_COLLECTION)) {
          return Response.json(bookmark);
        }
        if (url.includes("getRecord")) {
          return new Response("not found", { status: 404 });
        }
        if (url.includes("putRecord")) {
          putCalls.push(JSON.parse(options?.body));
          return Response.json({
            uri: bookmark.uri,
            cid: "cid-updated",
          });
        }
        if (url.includes("listRecords")) {
          return Response.json({ records: [] });
        }
        return Response.json({});
      }),
    )
  );

  const res = await handler(
    new Request("https://kipclip.com/api/bookmarks/bulk", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "add-tags",
        uris: [bookmark.uri],
        tags: ["swift"], // lowercase — should not be added since "Swift" exists
      }),
    }),
  );

  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.success, true);
  // The tags should still be just ["Swift"] — no duplicate
  const putCall = putCalls.find((c) => c.collection === BOOKMARK_COLLECTION);
  assertEquals(putCall.record.tags, ["Swift"]);
});

Deno.test("bulk remove-tags - removes tags case-insensitively", async () => {
  const bookmark = bookmarkRecord("bk1", ["Swift", "Rust"]);
  const putCalls: any[] = [];

  setTestSessionProvider(() =>
    Promise.resolve(
      createSession((_method, url, options) => {
        if (url.includes("getRecord") && url.includes(BOOKMARK_COLLECTION)) {
          return Response.json(bookmark);
        }
        if (url.includes("getRecord")) {
          return new Response("not found", { status: 404 });
        }
        if (url.includes("putRecord")) {
          putCalls.push(JSON.parse(options?.body));
          return Response.json({
            uri: bookmark.uri,
            cid: "cid-updated",
          });
        }
        return Response.json({});
      }),
    )
  );

  const res = await handler(
    new Request("https://kipclip.com/api/bookmarks/bulk", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "remove-tags",
        uris: [bookmark.uri],
        tags: ["swift"], // lowercase — should remove "Swift"
      }),
    }),
  );

  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.success, true);
  const putCall = putCalls.find((c) => c.collection === BOOKMARK_COLLECTION);
  assertEquals(putCall.record.tags, ["Rust"]);
});

// ---------- GET /api/tags/:rkey/usage — case-insensitive count ----------

Deno.test("GET /api/tags/:rkey/usage - counts case-insensitive matches", async () => {
  const tag = tagRecord("tag1", "Swift");
  const bookmarks = [
    bookmarkRecord("bk1", ["Swift"]),
    bookmarkRecord("bk2", ["swift"]), // different case, should still count
    bookmarkRecord("bk3", ["Rust"]), // unrelated, should not count
  ];

  setTestSessionProvider(() =>
    Promise.resolve(
      createSession((_method, url) => {
        if (url.includes("getRecord")) {
          return Response.json(tag);
        }
        if (url.includes("listRecords")) {
          return Response.json({ records: bookmarks });
        }
        return Response.json({});
      }),
    )
  );

  const res = await handler(
    tagRequest("GET", "/api/tags/tag1/usage"),
  );
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.count, 2); // Both "Swift" and "swift" match
});

// ---------- DELETE /api/tags/:rkey — case-insensitive removal ----------

Deno.test("DELETE /api/tags/:rkey - removes tag case-insensitively from bookmarks", async () => {
  const tag = tagRecord("tag1", "Swift");
  const bookmark = bookmarkRecord("bk1", ["swift", "Rust"]); // lowercase variant
  const putCalls: any[] = [];

  setTestSessionProvider(() =>
    Promise.resolve(
      createSession((_method, url, options) => {
        if (url.includes("getRecord")) {
          return Response.json(tag);
        }
        if (url.includes("listRecords")) {
          return Response.json({ records: [bookmark] });
        }
        if (url.includes("putRecord")) {
          putCalls.push(JSON.parse(options?.body));
          return Response.json({ uri: bookmark.uri, cid: "cid-updated" });
        }
        if (url.includes("deleteRecord")) {
          return Response.json({});
        }
        return Response.json({});
      }),
    )
  );

  const res = await handler(tagRequest("DELETE", "/api/tags/tag1"));
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.success, true);

  // "swift" should have been removed even though the tag record says "Swift"
  const putCall = putCalls.find((c) => c.collection === BOOKMARK_COLLECTION);
  assertEquals(putCall.record.tags, ["Rust"]);
});

// ---------- POST /api/tags/merge-duplicates ----------

Deno.test("POST /api/tags/merge-duplicates - merges case-insensitive duplicates", async () => {
  const tags = [
    tagRecord("tag1", "Swift", "2026-01-01T00:00:00.000Z"),
    tagRecord("tag2", "swift", "2026-01-02T00:00:00.000Z"),
    tagRecord("tag3", "SWIFT", "2026-01-03T00:00:00.000Z"),
    tagRecord("tag4", "Rust"), // no duplicates
  ];
  const bookmarks = [
    bookmarkRecord("bk1", ["swift", "Rust"]),
  ];

  const deletedTags: string[] = [];
  const putCalls: any[] = [];

  setTestSessionProvider(() =>
    Promise.resolve(
      createSession((_method, url, options) => {
        if (url.includes("listRecords") && url.includes(TAG_COLLECTION)) {
          return Response.json({ records: tags });
        }
        if (
          url.includes("listRecords") && url.includes(BOOKMARK_COLLECTION)
        ) {
          return Response.json({ records: bookmarks });
        }
        if (url.includes("deleteRecord")) {
          const body = JSON.parse(options?.body);
          deletedTags.push(body.rkey);
          return Response.json({});
        }
        if (url.includes("putRecord")) {
          putCalls.push(JSON.parse(options?.body));
          return Response.json({ uri: "at://test", cid: "cid-updated" });
        }
        return Response.json({});
      }),
    )
  );

  const res = await handler(
    tagRequest("POST", "/api/tags/merge-duplicates"),
  );
  assertEquals(res.status, 200);
  const body = await res.json();

  assertEquals(body.merged, 1); // One group of duplicates
  assertEquals(body.tagsDeleted, 2); // "swift" and "SWIFT" deleted
  assertEquals(body.bookmarksUpdated, 1); // bk1 had "swift" -> "Swift"

  // The canonical tag should be "Swift" (earliest createdAt)
  assertEquals(body.details[0].canonical, "Swift");
  assertEquals(body.details[0].merged.sort(), ["SWIFT", "swift"]);

  // Tag2 and tag3 should be deleted
  assertEquals(deletedTags.sort(), ["tag2", "tag3"]);

  // Bookmark should be updated to use "Swift" instead of "swift"
  const bookmarkPut = putCalls.find(
    (c) => c.collection === BOOKMARK_COLLECTION,
  );
  assertEquals(bookmarkPut.record.tags, ["Swift", "Rust"]);
});

Deno.test("POST /api/tags/merge-duplicates - no duplicates returns zero", async () => {
  const tags = [
    tagRecord("tag1", "Swift"),
    tagRecord("tag2", "Rust"),
  ];

  setTestSessionProvider(() =>
    Promise.resolve(
      createSession((_method, url) => {
        if (url.includes("listRecords")) {
          return Response.json({ records: tags });
        }
        return Response.json({});
      }),
    )
  );

  const res = await handler(
    tagRequest("POST", "/api/tags/merge-duplicates"),
  );
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.merged, 0);
  assertEquals(body.tagsDeleted, 0);
  assertEquals(body.bookmarksUpdated, 0);
});
