import "./test-setup.ts";
import { assertEquals } from "@std/assert";
import { app } from "../main.ts";
import { clearMirrorTables, db } from "./mirror-test-setup.ts";
import { setTestSessionProvider } from "../lib/session.ts";
import { createMockSessionResult } from "./test-helpers.ts";

Deno.test("bookmark create/edit publish durable jobs without doing outbound delivery", async () => {
  await clearMirrorTables();
  const session = createMockSessionResult();
  const did = session.session!.did;
  const uri = `at://${did}/community.lexicon.bookmarks.bookmark/abc123`;
  let fail = false;
  let revision = 0;
  session.session!.makeRequest = (_method, url) => {
    if (url.includes("listRecords")) {
      return Promise.resolve(Response.json({ records: [] }));
    }
    if (url.includes("getRecord")) {
      if (
        new URL(url).searchParams.get("collection") ===
          "community.lexicon.bookmarks.bookmark"
      ) {
        return Promise.resolve(
          Response.json({
            uri,
            cid: `cid${revision}`,
            value: {
              subject: "https://example.invalid/saved",
              createdAt: "2026-01-01T00:00:00Z",
              tags: [],
            },
          }),
        );
      }
      return Promise.resolve(
        Response.json({ error: "RecordNotFound" }, { status: 400 }),
      );
    }
    if (fail) {
      return Promise.resolve(
        Response.json({ error: "InvalidSwap" }, { status: 400 }),
      );
    }
    return Promise.resolve(Response.json({ uri, cid: `cid${++revision}` }));
  };
  const oldFetch = globalThis.fetch;
  let outbound = 0;
  globalThis.fetch = (input) => {
    if (String(input).includes("instapaper.com")) outbound++;
    return Promise.resolve(
      new Response("<html><title>Example</title></html>", {
        headers: { "content-type": "text/html" },
      }),
    );
  };
  setTestSessionProvider(() => Promise.resolve(session));
  const request = (method: string, path: string) =>
    app.handler()(
      new Request(`https://kipclip.com${path}`, {
        method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          url: "https://example.invalid/saved",
          tags: ["ToRead"],
        }),
      }),
    );
  try {
    assertEquals((await request("POST", "/api/bookmarks")).status, 200);
    assertEquals(
      (await db.execute({
        sql: "SELECT action FROM event_action_jobs ORDER BY action",
        args: [],
      })).rows,
      [["instapaper"], ["preview"]],
    );
    assertEquals((await request("PATCH", "/api/bookmarks/abc123")).status, 200);
    const beforeFailure =
      (await db.execute({ sql: "SELECT version FROM app_events", args: [] }))
        .rows;
    fail = true;
    assertEquals((await request("POST", "/api/bookmarks")).status, 500);
    assertEquals((await request("PATCH", "/api/bookmarks/abc123")).status, 409);
    assertEquals(
      (await db.execute({ sql: "SELECT version FROM app_events", args: [] }))
        .rows,
      beforeFailure,
    );
    // Failed deletes preserve queued work; a successful local delete cancels
    // it before any TAP echo or background delivery can arrive.
    assertEquals(
      (await request("DELETE", "/api/bookmarks/abc123")).status,
      500,
    );
    assertEquals(
      (await db.execute({
        sql: "SELECT COUNT(*) FROM event_action_jobs",
        args: [],
      })).rows,
      [[2]],
    );
    fail = false;
    assertEquals(
      (await request("DELETE", "/api/bookmarks/abc123")).status,
      200,
    );
    assertEquals(
      (await db.execute({
        sql: "SELECT COUNT(*) FROM event_action_jobs",
        args: [],
      })).rows,
      [[0]],
    );
    assertEquals(outbound, 0);
  } finally {
    globalThis.fetch = oldFetch;
    setTestSessionProvider(null);
  }
});
