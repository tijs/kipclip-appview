/**
 * Tests for bulk bookmark operations API.
 * Tests POST /api/bookmarks/bulk for delete, add-tags, remove-tags.
 */

import "./test-setup.ts";

import { assertEquals } from "@std/assert";
import { app } from "../main.ts";
import { initOAuth } from "../lib/oauth-config.ts";
import { setTestSessionProvider } from "../lib/session.ts";
import type { SessionResult } from "../lib/session.ts";
import type { BulkOperationResponse } from "../shared/types.ts";

initOAuth(new Request("https://kipclip.com"));
const handler = app.handler();

const TEST_DID = "did:plc:test123";
const BOOKMARK_COLLECTION = "community.lexicon.bookmarks.bookmark";
const ANNOTATION_COLLECTION = "com.kipclip.annotation";
const TAG_COLLECTION = "com.kipclip.tag";

function bulkRequest(body: unknown): Request {
  return new Request("https://kipclip.com/api/bookmarks/bulk", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** Create a mock session with a flexible makeRequest handler. */
function createBulkSession(
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

/** Standard bookmark record as returned by getRecord. */
function bookmarkRecord(rkey: string, tags: string[] = []) {
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

// ---------- Validation Tests ----------

Deno.test("POST /api/bookmarks/bulk - returns 401 without auth", async () => {
  setTestSessionProvider(() =>
    Promise.resolve({ session: null, setCookieHeader: undefined } as any)
  );

  const res = await handler(bulkRequest({ action: "delete", uris: ["a"] }));
  assertEquals(res.status, 401);
});

Deno.test("POST /api/bookmarks/bulk - rejects missing action", async () => {
  setTestSessionProvider(() =>
    Promise.resolve(
      createBulkSession(() => new Response("{}", { status: 200 })),
    )
  );

  const res = await handler(bulkRequest({ uris: ["a"] }));
  assertEquals(res.status, 400);
  const body = await res.json();
  assertEquals(body.error, "action and uris[] are required");
});

Deno.test("POST /api/bookmarks/bulk - rejects empty uris", async () => {
  setTestSessionProvider(() =>
    Promise.resolve(
      createBulkSession(() => new Response("{}", { status: 200 })),
    )
  );

  const res = await handler(bulkRequest({ action: "delete", uris: [] }));
  assertEquals(res.status, 400);
});

Deno.test("POST /api/bookmarks/bulk - rejects add-tags without tags", async () => {
  setTestSessionProvider(() =>
    Promise.resolve(
      createBulkSession(() => new Response("{}", { status: 200 })),
    )
  );

  const res = await handler(bulkRequest({ action: "add-tags", uris: ["a"] }));
  assertEquals(res.status, 400);
  const body = await res.json();
  assertEquals(body.error, "tags[] is required for tag operations");
});

// ---------- Delete Tests ----------

Deno.test("POST /api/bookmarks/bulk - delete succeeds", async () => {
  const applyWritesCalls: any[] = [];

  setTestSessionProvider(() =>
    Promise.resolve(
      createBulkSession((_method, url, options) => {
        if (url.includes("applyWrites")) {
          const body = JSON.parse(options?.body);
          applyWritesCalls.push(body);
          return new Response(JSON.stringify({ results: [] }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response("{}", { status: 200 });
      }),
    )
  );

  const uris = [
    `at://${TEST_DID}/${BOOKMARK_COLLECTION}/rkey1`,
    `at://${TEST_DID}/${BOOKMARK_COLLECTION}/rkey2`,
  ];

  const res = await handler(bulkRequest({ action: "delete", uris }));
  assertEquals(res.status, 200);

  const body: BulkOperationResponse = await res.json();
  assertEquals(body.success, true);
  assertEquals(body.succeeded, 2);
  assertEquals(body.failed, 0);

  // Should have called applyWrites for bookmark deletes
  const bookmarkDeletes = applyWritesCalls.find((call) =>
    call.writes.some((w: any) => w.collection === BOOKMARK_COLLECTION)
  );
  assertEquals(bookmarkDeletes.writes.length, 2);
  assertEquals(
    bookmarkDeletes.writes[0].$type,
    "com.atproto.repo.applyWrites#delete",
  );
});

Deno.test("POST /api/bookmarks/bulk - delete handles partial failure", async () => {
  let callCount = 0;

  setTestSessionProvider(() =>
    Promise.resolve(
      createBulkSession((_method, url) => {
        if (url.includes("applyWrites")) {
          callCount++;
          // First batch succeeds, second fails (if batching by 10)
          // With 12 items, first batch of 10 succeeds, second of 2 fails
          if (callCount === 2) {
            return new Response("PDS error", { status: 500 });
          }
          return new Response(JSON.stringify({ results: [] }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response("{}", { status: 200 });
      }),
    )
  );

  // Create 12 URIs to force 2 batches (10 + 2)
  const uris = Array.from(
    { length: 12 },
    (_, i) => `at://${TEST_DID}/${BOOKMARK_COLLECTION}/rkey${i}`,
  );

  const res = await handler(bulkRequest({ action: "delete", uris }));
  assertEquals(res.status, 200);

  const body: BulkOperationResponse = await res.json();
  assertEquals(body.success, false);
  assertEquals(body.succeeded, 10);
  assertEquals(body.failed, 2);
  assertEquals(body.errors!.length, 1);
});

// ---------- Add Tags Tests ----------

Deno.test("POST /api/bookmarks/bulk - add-tags succeeds", async () => {
  setTestSessionProvider(() =>
    Promise.resolve(
      createBulkSession((_method, url, options) => {
        // getRecord for bookmark
        if (
          url.includes("getRecord") &&
          url.includes(BOOKMARK_COLLECTION)
        ) {
          const rkey = new URL(url).searchParams.get("rkey") || "rkey1";
          return new Response(
            JSON.stringify(bookmarkRecord(rkey, ["existing"])),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            },
          );
        }
        // getRecord for annotation - return 404 (no annotation)
        if (
          url.includes("getRecord") &&
          url.includes(ANNOTATION_COLLECTION)
        ) {
          return new Response("Not found", { status: 404 });
        }
        // putRecord for bookmark update
        if (url.includes("putRecord")) {
          const body = JSON.parse(options?.body);
          return new Response(
            JSON.stringify({
              uri: `at://${TEST_DID}/${BOOKMARK_COLLECTION}/${body.rkey}`,
              cid: "updated-cid",
            }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            },
          );
        }
        // listRecords for tag existence check
        if (url.includes("listRecords")) {
          return new Response(
            JSON.stringify({ records: [] }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            },
          );
        }
        // createRecord for new tag
        if (url.includes("createRecord")) {
          return new Response(
            JSON.stringify({
              uri: `at://${TEST_DID}/${TAG_COLLECTION}/newtag`,
              cid: "tag-cid",
            }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            },
          );
        }
        return new Response("{}", { status: 200 });
      }),
    )
  );

  const uris = [`at://${TEST_DID}/${BOOKMARK_COLLECTION}/rkey1`];
  const res = await handler(
    bulkRequest({ action: "add-tags", uris, tags: ["newtag"] }),
  );
  assertEquals(res.status, 200);

  const body: BulkOperationResponse = await res.json();
  assertEquals(body.success, true);
  assertEquals(body.succeeded, 1);
  assertEquals(body.failed, 0);
  assertEquals(body.bookmarks!.length, 1);
  // Should have both existing and new tag
  assertEquals(body.bookmarks![0].tags!.includes("existing"), true);
  assertEquals(body.bookmarks![0].tags!.includes("newtag"), true);
});

// ---------- Remove Tags Tests ----------

Deno.test("POST /api/bookmarks/bulk - remove-tags succeeds", async () => {
  setTestSessionProvider(() =>
    Promise.resolve(
      createBulkSession((_method, url, options) => {
        if (
          url.includes("getRecord") &&
          url.includes(BOOKMARK_COLLECTION)
        ) {
          const rkey = new URL(url).searchParams.get("rkey") || "rkey1";
          return new Response(
            JSON.stringify(bookmarkRecord(rkey, ["keep", "remove-me"])),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            },
          );
        }
        if (
          url.includes("getRecord") &&
          url.includes(ANNOTATION_COLLECTION)
        ) {
          return new Response("Not found", { status: 404 });
        }
        if (url.includes("putRecord")) {
          const body = JSON.parse(options?.body);
          return new Response(
            JSON.stringify({
              uri: `at://${TEST_DID}/${BOOKMARK_COLLECTION}/${body.rkey}`,
              cid: "updated-cid",
            }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            },
          );
        }
        return new Response("{}", { status: 200 });
      }),
    )
  );

  const uris = [`at://${TEST_DID}/${BOOKMARK_COLLECTION}/rkey1`];
  const res = await handler(
    bulkRequest({ action: "remove-tags", uris, tags: ["remove-me"] }),
  );
  assertEquals(res.status, 200);

  const body: BulkOperationResponse = await res.json();
  assertEquals(body.success, true);
  assertEquals(body.succeeded, 1);
  assertEquals(body.bookmarks!.length, 1);
  assertEquals(body.bookmarks![0].tags, ["keep"]);
});
