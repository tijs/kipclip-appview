/**
 * Integration tests for the import API endpoint.
 * Tests auth, file parsing, dedup, and synchronous bookmark processing.
 */

import "./test-setup.ts";

import { assertEquals } from "@std/assert";
import { app } from "../main.ts";
import { initOAuth } from "../lib/oauth-config.ts";
import { setTestSessionProvider } from "../lib/session.ts";
import {
  createMockSessionResult,
  listRecordsResponse,
} from "./test-helpers.ts";

initOAuth(new Request("https://kipclip.com"));
const handler = app.handler();

// Helper to create a multipart form request with a file
function createImportRequest(
  content: string,
  filename: string,
): Request {
  const formData = new FormData();
  formData.append("file", new File([content], filename));
  return new Request("https://kipclip.com/api/import", {
    method: "POST",
    body: formData,
  });
}

/** Create a mock session that returns OK for applyWrites and listRecords. */
function createImportSession(
  existingRecords: Array<{ uri: string; cid: string; value: unknown }> = [],
) {
  const pdsResponses = new Map<string, Response>();
  pdsResponses.set("listRecords", listRecordsResponse(existingRecords));
  pdsResponses.set(
    "applyWrites",
    new Response(JSON.stringify({ results: [] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  );
  // Default OK for createRecord (tag creation)
  return createMockSessionResult({ pdsResponses });
}

Deno.test("POST /api/import - returns 401 when not authenticated", async () => {
  setTestSessionProvider(null);
  const req = createImportRequest("test", "bookmarks.html");
  const res = await handler(req);

  assertEquals(res.status, 401);
  const body = await res.json();
  assertEquals(body.error, "Authentication required");
});

Deno.test({
  name: "POST /api/import - returns 400 for unrecognized format",
  async fn() {
    const pdsResponses = new Map<string, Response>();
    pdsResponses.set("listRecords", listRecordsResponse([]));

    setTestSessionProvider(() =>
      Promise.resolve(createMockSessionResult({ pdsResponses }))
    );

    const req = createImportRequest(
      "just some random text that is not a bookmark file",
      "random.txt",
    );
    const res = await handler(req);

    assertEquals(res.status, 400);
    const body = await res.json();
    assertEquals(body.success, false);
    assertEquals(body.error?.includes("Unrecognized file format"), true);

    setTestSessionProvider(null);
  },
});

Deno.test({
  name: "POST /api/import - returns 400 for empty file",
  async fn() {
    setTestSessionProvider(() => Promise.resolve(createMockSessionResult()));

    const req = createImportRequest("", "empty.html");
    const res = await handler(req);

    assertEquals(res.status, 400);
    const body = await res.json();
    assertEquals(body.success, false);
    assertEquals(body.error, "File is empty");

    setTestSessionProvider(null);
  },
});

Deno.test({
  name: "POST /api/import - imports bookmarks synchronously",
  async fn() {
    setTestSessionProvider(() => Promise.resolve(createImportSession()));

    const pinboardJson = JSON.stringify([
      {
        href: "https://example.com/one",
        description: "First Link",
        extended: "",
        tags: "tech",
        time: "2024-01-15T10:30:00Z",
      },
      {
        href: "https://example.com/two",
        description: "Second Link",
        extended: "A description",
        tags: "blog reading",
        time: "2024-02-20T14:00:00Z",
      },
    ]);

    const req = createImportRequest(pinboardJson, "pinboard.json");
    const res = await handler(req);

    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.success, true);
    assertEquals(body.jobId, undefined);
    assertEquals(body.result.format, "pinboard");
    assertEquals(body.result.total, 2);
    assertEquals(body.result.skipped, 0);
    assertEquals(body.result.imported, 2);

    setTestSessionProvider(null);
  },
});

Deno.test({
  name: "POST /api/import - returns synchronous result when all duplicates",
  async fn() {
    setTestSessionProvider(() =>
      Promise.resolve(
        createImportSession([
          {
            uri:
              "at://did:plc:test123/community.lexicon.bookmarks.bookmark/existing1",
            cid: "bafyexisting1",
            value: {
              subject: "https://example.com/one",
              createdAt: "2024-01-01T00:00:00Z",
              tags: [],
            },
          },
          {
            uri:
              "at://did:plc:test123/community.lexicon.bookmarks.bookmark/existing2",
            cid: "bafyexisting2",
            value: {
              subject: "https://example.com/two",
              createdAt: "2024-01-01T00:00:00Z",
              tags: [],
            },
          },
        ]),
      )
    );

    const pinboardJson = JSON.stringify([
      { href: "https://example.com/one", description: "Dup1", tags: "" },
      { href: "https://example.com/two", description: "Dup2", tags: "" },
    ]);

    const req = createImportRequest(pinboardJson, "pinboard.json");
    const res = await handler(req);

    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.success, true);
    assertEquals(body.jobId, undefined);
    assertEquals(body.result.total, 2);
    assertEquals(body.result.skipped, 2);
    assertEquals(body.result.imported, 0);

    setTestSessionProvider(null);
  },
});

Deno.test({
  name: "POST /api/import - partial dedup imports only new bookmarks",
  async fn() {
    setTestSessionProvider(() =>
      Promise.resolve(
        createImportSession([
          {
            uri:
              "at://did:plc:test123/community.lexicon.bookmarks.bookmark/existing1",
            cid: "bafyexisting1",
            value: {
              subject: "https://example.com/one",
              createdAt: "2024-01-01T00:00:00Z",
              tags: [],
            },
          },
        ]),
      )
    );

    const pinboardJson = JSON.stringify([
      { href: "https://example.com/one", description: "Dup", tags: "" },
      {
        href: "https://example.com/new",
        description: "New Link",
        tags: "",
      },
    ]);

    const req = createImportRequest(pinboardJson, "pinboard.json");
    const res = await handler(req);

    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.success, true);
    assertEquals(body.jobId, undefined);
    assertEquals(body.result.total, 2);
    assertEquals(body.result.skipped, 1);
    assertEquals(body.result.imported, 1);

    setTestSessionProvider(null);
  },
});

Deno.test({
  name: "POST /api/import - Netscape HTML imports synchronously",
  async fn() {
    setTestSessionProvider(() => Promise.resolve(createImportSession()));

    const html = `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<DL><p>
<DT><A HREF="https://example.com/page" ADD_DATE="1700000000" TAGS="tech">A Page</A>
</DL>`;

    const req = createImportRequest(html, "bookmarks.html");
    const res = await handler(req);

    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.success, true);
    assertEquals(body.result.format, "netscape");
    assertEquals(body.result.total, 1);
    assertEquals(body.result.imported, 1);

    setTestSessionProvider(null);
  },
});

Deno.test({
  name: "POST /api/import - Pocket CSV imports synchronously",
  async fn() {
    setTestSessionProvider(() => Promise.resolve(createImportSession()));

    const csv =
      "url,title,tags,time_added\nhttps://example.com/pocket,Pocket Article,tech,1700000000\n";

    const req = createImportRequest(csv, "pocket.csv");
    const res = await handler(req);

    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.success, true);
    assertEquals(body.result.format, "pocket");
    assertEquals(body.result.total, 1);
    assertEquals(body.result.imported, 1);

    setTestSessionProvider(null);
  },
});

Deno.test({
  name: "POST /api/import - Instapaper CSV imports synchronously",
  async fn() {
    setTestSessionProvider(() => Promise.resolve(createImportSession()));

    const csv =
      "URL,Title,Selection,Folder\nhttps://example.com/insta,Instapaper Article,,Tech\n";

    const req = createImportRequest(csv, "instapaper.csv");
    const res = await handler(req);

    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.success, true);
    assertEquals(body.result.format, "instapaper");
    assertEquals(body.result.total, 1);
    assertEquals(body.result.imported, 1);

    setTestSessionProvider(null);
  },
});

Deno.test({
  name:
    "POST /api/import - returns success with 0 imported for empty bookmark file",
  async fn() {
    const pdsResponses = new Map<string, Response>();
    pdsResponses.set("listRecords", listRecordsResponse([]));

    setTestSessionProvider(() =>
      Promise.resolve(createMockSessionResult({ pdsResponses }))
    );

    // Valid Pinboard JSON but no valid HTTP entries
    const req = createImportRequest(
      '[{"href":"ftp://not-http.com","description":"Skip me"}]',
      "pinboard.json",
    );
    const res = await handler(req);

    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.success, true);
    assertEquals(body.result.total, 0);
    assertEquals(body.result.imported, 0);

    setTestSessionProvider(null);
  },
});

Deno.test({
  name: "POST /api/import - returns 400 when no file provided",
  async fn() {
    setTestSessionProvider(() => Promise.resolve(createMockSessionResult()));

    // Send form data without a file
    const formData = new FormData();
    formData.append("notfile", "something");
    const req = new Request("https://kipclip.com/api/import", {
      method: "POST",
      body: formData,
    });

    const res = await handler(req);

    assertEquals(res.status, 400);
    const body = await res.json();
    assertEquals(body.success, false);
    assertEquals(body.error, "No file provided");

    setTestSessionProvider(null);
  },
});

Deno.test({
  name: "POST /api/import - handles applyWrites failure gracefully",
  async fn() {
    const pdsResponses = new Map<string, Response>();
    pdsResponses.set("listRecords", listRecordsResponse([]));
    pdsResponses.set(
      "applyWrites",
      new Response(JSON.stringify({ error: "Internal error" }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      }),
    );

    setTestSessionProvider(() =>
      Promise.resolve(createMockSessionResult({ pdsResponses }))
    );

    const pinboardJson = JSON.stringify([
      {
        href: "https://example.com/fail-test",
        description: "Will fail",
        tags: "",
      },
    ]);

    const req = createImportRequest(pinboardJson, "pinboard.json");
    const res = await handler(req);

    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.success, true);
    assertEquals(body.result.total, 1);
    assertEquals(body.result.imported, 0);
    assertEquals(body.result.failed, 1);

    setTestSessionProvider(null);
  },
});
