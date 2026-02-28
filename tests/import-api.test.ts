/**
 * Integration tests for the two-phase import API.
 * Tests prepare (POST /api/import) and process (POST /api/import/:jobId/process).
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

/** Helper to drive an import to completion: prepare + process loop. */
async function runFullImport(
  content: string,
  filename: string,
  existingRecords: Array<{ uri: string; cid: string; value: unknown }> = [],
): Promise<{ prepareBody: any; processBody?: any }> {
  setTestSessionProvider(() =>
    Promise.resolve(createImportSession(existingRecords))
  );

  const req = createImportRequest(content, filename);
  const res = await handler(req);
  const prepareBody = await res.json();

  if (!prepareBody.jobId) {
    return { prepareBody };
  }

  // Process all chunks
  let processBody;
  let done = false;
  while (!done) {
    const processReq = new Request(
      `https://kipclip.com/api/import/${prepareBody.jobId}/process`,
      { method: "POST" },
    );
    const processRes = await handler(processReq);
    processBody = await processRes.json();
    done = processBody.done === true;
  }

  setTestSessionProvider(null);
  return { prepareBody, processBody };
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
  name: "POST /api/import - prepare creates job for valid import",
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
    assertEquals(typeof body.jobId, "string");
    assertEquals(body.total, 2);
    assertEquals(body.skipped, 0);
    assertEquals(body.toImport, 2);
    assertEquals(body.totalChunks, 1);
    assertEquals(body.format, "pinboard");

    setTestSessionProvider(null);
  },
});

Deno.test({
  name: "POST /api/import - returns result directly when all duplicates",
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
  name: "Process: imports chunk and returns done",
  async fn() {
    const { prepareBody, processBody } = await runFullImport(
      JSON.stringify([
        {
          href: "https://example.com/one",
          description: "First Link",
          tags: "tech",
          time: "2024-01-15T10:30:00Z",
        },
        {
          href: "https://example.com/two",
          description: "Second Link",
          tags: "blog",
          time: "2024-02-20T14:00:00Z",
        },
      ]),
      "pinboard.json",
    );

    assertEquals(prepareBody.success, true);
    assertEquals(typeof prepareBody.jobId, "string");
    assertEquals(processBody.success, true);
    assertEquals(processBody.done, true);
    assertEquals(processBody.result.imported, 2);
    assertEquals(processBody.result.format, "pinboard");
  },
});

Deno.test({
  name: "Process: partial dedup imports only new bookmarks",
  async fn() {
    const { prepareBody, processBody } = await runFullImport(
      JSON.stringify([
        { href: "https://example.com/one", description: "Dup", tags: "" },
        {
          href: "https://example.com/new",
          description: "New Link",
          tags: "",
        },
      ]),
      "pinboard.json",
      [
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
      ],
    );

    assertEquals(prepareBody.success, true);
    assertEquals(prepareBody.toImport, 1);
    assertEquals(prepareBody.skipped, 1);
    assertEquals(processBody.success, true);
    assertEquals(processBody.done, true);
    assertEquals(processBody.result.imported, 1);
    assertEquals(processBody.result.skipped, 1);
    assertEquals(processBody.result.total, 2);
  },
});

Deno.test({
  name: "Process: Netscape HTML imports via two-phase flow",
  async fn() {
    const { processBody } = await runFullImport(
      `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<DL><p>
<DT><A HREF="https://example.com/page" ADD_DATE="1700000000" TAGS="tech">A Page</A>
</DL>`,
      "bookmarks.html",
    );

    assertEquals(processBody.success, true);
    assertEquals(processBody.done, true);
    assertEquals(processBody.result.format, "netscape");
    assertEquals(processBody.result.imported, 1);
  },
});

Deno.test({
  name: "Process: Pocket CSV imports via two-phase flow",
  async fn() {
    const { processBody } = await runFullImport(
      "url,title,tags,time_added\nhttps://example.com/pocket,Pocket Article,tech,1700000000\n",
      "pocket.csv",
    );

    assertEquals(processBody.success, true);
    assertEquals(processBody.done, true);
    assertEquals(processBody.result.format, "pocket");
    assertEquals(processBody.result.imported, 1);
  },
});

Deno.test({
  name: "Process: Instapaper CSV imports via two-phase flow",
  async fn() {
    const { processBody } = await runFullImport(
      "URL,Title,Selection,Folder\nhttps://example.com/insta,Instapaper Article,,Tech\n",
      "instapaper.csv",
    );

    assertEquals(processBody.success, true);
    assertEquals(processBody.done, true);
    assertEquals(processBody.result.format, "instapaper");
    assertEquals(processBody.result.imported, 1);
  },
});

Deno.test({
  name: "Process: wrong DID returns 403",
  async fn() {
    // Create job with default DID (did:plc:test123)
    setTestSessionProvider(() => Promise.resolve(createImportSession()));

    const req = createImportRequest(
      JSON.stringify([
        {
          href: "https://example.com/forbidden",
          description: "Test",
          tags: "",
        },
      ]),
      "pinboard.json",
    );
    const res = await handler(req);
    const prepareBody = await res.json();
    const jobId = prepareBody.jobId;

    // Switch to different DID session
    const otherSession = createMockSessionResult({ did: "did:plc:other999" });
    setTestSessionProvider(() => Promise.resolve(otherSession));

    const processReq = new Request(
      `https://kipclip.com/api/import/${jobId}/process`,
      { method: "POST" },
    );
    const processRes = await handler(processReq);

    assertEquals(processRes.status, 403);
    const processBody = await processRes.json();
    assertEquals(processBody.success, false);
    assertEquals(processBody.error, "Forbidden");

    setTestSessionProvider(null);
  },
});

Deno.test({
  name: "Process: unknown jobId returns 404",
  async fn() {
    setTestSessionProvider(() => Promise.resolve(createMockSessionResult()));

    const processReq = new Request(
      "https://kipclip.com/api/import/nonexistent-job-id/process",
      { method: "POST" },
    );
    const processRes = await handler(processReq);

    assertEquals(processRes.status, 404);
    const body = await processRes.json();
    assertEquals(body.success, false);
    assertEquals(body.error, "Import job not found");

    setTestSessionProvider(null);
  },
});

Deno.test({
  name: "Process: handles applyWrites failure gracefully",
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

    // Prepare
    const req = createImportRequest(
      JSON.stringify([
        {
          href: "https://example.com/fail-test",
          description: "Will fail",
          tags: "",
        },
      ]),
      "pinboard.json",
    );
    const res = await handler(req);
    const prepareBody = await res.json();
    assertEquals(prepareBody.success, true);
    assertEquals(typeof prepareBody.jobId, "string");

    // Process — should handle failure
    const processReq = new Request(
      `https://kipclip.com/api/import/${prepareBody.jobId}/process`,
      { method: "POST" },
    );
    const processRes = await handler(processReq);
    const processBody = await processRes.json();

    assertEquals(processRes.status, 200);
    assertEquals(processBody.success, true);
    assertEquals(processBody.done, true);
    assertEquals(processBody.result.imported, 0);
    assertEquals(processBody.result.failed, 1);

    setTestSessionProvider(null);
  },
});

Deno.test({
  name: "Process: multi-chunk import updates cumulative counters",
  async fn() {
    // Generate 201 bookmarks to force 2 chunks (CHUNK_SIZE = 200)
    const bookmarks = Array.from({ length: 201 }, (_, i) => ({
      href: `https://example.com/multi-chunk-${i}`,
      description: `Link ${i}`,
      tags: "",
    }));

    setTestSessionProvider(() => Promise.resolve(createImportSession()));

    const req = createImportRequest(
      JSON.stringify(bookmarks),
      "pinboard.json",
    );
    const res = await handler(req);
    const prepareBody = await res.json();

    assertEquals(prepareBody.success, true);
    assertEquals(prepareBody.totalChunks, 2);
    assertEquals(prepareBody.toImport, 201);

    // Process first chunk
    const process1Req = new Request(
      `https://kipclip.com/api/import/${prepareBody.jobId}/process`,
      { method: "POST" },
    );
    const process1Res = await handler(process1Req);
    const process1Body = await process1Res.json();

    assertEquals(process1Body.success, true);
    assertEquals(process1Body.done, false);
    assertEquals(process1Body.imported, 200);
    assertEquals(process1Body.totalImported, 200);
    assertEquals(process1Body.remaining, 1);

    // Process second chunk
    const process2Req = new Request(
      `https://kipclip.com/api/import/${prepareBody.jobId}/process`,
      { method: "POST" },
    );
    const process2Res = await handler(process2Req);
    const process2Body = await process2Res.json();

    assertEquals(process2Body.success, true);
    assertEquals(process2Body.done, true);
    assertEquals(process2Body.imported, 1);
    assertEquals(process2Body.totalImported, 201);
    assertEquals(process2Body.result.imported, 201);
    assertEquals(process2Body.result.total, 201);

    setTestSessionProvider(null);
  },
});

Deno.test({
  name: "Process: 401 without session",
  async fn() {
    setTestSessionProvider(null);

    const processReq = new Request(
      "https://kipclip.com/api/import/some-job-id/process",
      { method: "POST" },
    );
    const processRes = await handler(processReq);

    assertEquals(processRes.status, 401);
    const body = await processRes.json();
    assertEquals(body.error, "Authentication required");
  },
});
