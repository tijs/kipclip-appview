/**
 * Tests for routes/api/sync.ts — track / status / hook endpoints.
 */

import "./test-setup.ts";
import { clearMirrorTables } from "./mirror-test-setup.ts";

import { assertEquals } from "@std/assert";
import { app } from "../main.ts";
import { initOAuth } from "../lib/oauth-config.ts";
import { setTestSessionProvider } from "../lib/session.ts";
import { createMockSessionResult } from "./test-helpers.ts";

initOAuth(new Request("https://kipclip.com"));
const handler = app.handler();

const SESSION_DID = "did:plc:test123";
const OTHER_DID = "did:plc:other999";

const realFetch = globalThis.fetch;

interface FetchMock {
  calls: Array<{ url: string; init?: RequestInit }>;
  responses: Array<Response>;
}

function mockTapFetch(
  responses: Array<Response | (() => Response)>,
): FetchMock {
  const mock: FetchMock = { calls: [], responses: [] };
  let i = 0;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string"
      ? input
      : input instanceof URL
      ? input.href
      : input.url;
    if (url.startsWith("http://127.0.0.1:2480")) {
      mock.calls.push({ url, init });
      const r = responses[Math.min(i++, responses.length - 1)];
      const resp = typeof r === "function" ? r() : r;
      mock.responses.push(resp);
      return Promise.resolve(resp);
    }
    return realFetch(input, init);
  }) as typeof fetch;
  return mock;
}

function restoreFetch() {
  globalThis.fetch = realFetch;
}

function withSession(did: string = SESSION_DID) {
  setTestSessionProvider(() =>
    Promise.resolve(createMockSessionResult({ did }))
  );
}

function clearSession() {
  setTestSessionProvider(null);
}

Deno.test("POST /api/sync/track - returns 401 when unauthenticated", async () => {
  clearSession();
  const res = await handler(
    new Request("https://kipclip.com/api/sync/track", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ did: SESSION_DID }),
    }),
  );
  assertEquals(res.status, 401);
});

Deno.test("POST /api/sync/track - returns 403 for another DID", async () => {
  await clearMirrorTables();
  withSession(SESSION_DID);
  try {
    const res = await handler(
      new Request("https://kipclip.com/api/sync/track", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ did: OTHER_DID }),
      }),
    );
    assertEquals(res.status, 403);
  } finally {
    clearSession();
  }
});

Deno.test("POST /api/sync/track - returns 400 when did missing", async () => {
  withSession(SESSION_DID);
  try {
    const res = await handler(
      new Request("https://kipclip.com/api/sync/track", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      }),
    );
    assertEquals(res.status, 400);
  } finally {
    clearSession();
  }
});

Deno.test("POST /api/sync/track - calls TAP and inserts row on success", async () => {
  await clearMirrorTables();
  withSession(SESSION_DID);
  const tap = mockTapFetch([new Response(null, { status: 200 })]);
  try {
    const res = await handler(
      new Request("https://kipclip.com/api/sync/track", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ did: SESSION_DID }),
      }),
    );
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body, { tracking: true, did: SESSION_DID });
    assertEquals(tap.calls.length, 1);
    assertEquals(tap.calls[0].url, "http://127.0.0.1:2480/repos/add");
  } finally {
    restoreFetch();
    clearSession();
  }

  withSession(SESSION_DID);
  try {
    const res = await handler(
      new Request("https://kipclip.com/api/sync/status"),
    );
    const body = await res.json();
    assertEquals(body.tracking, true);
  } finally {
    clearSession();
  }
});

Deno.test("POST /api/sync/track - 502 when TAP unreachable, no row written", async () => {
  await clearMirrorTables();
  withSession(SESSION_DID);
  const tap = mockTapFetch([
    () => {
      throw new Error("ECONNREFUSED");
    },
  ]);
  try {
    const res = await handler(
      new Request("https://kipclip.com/api/sync/track", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ did: SESSION_DID }),
      }),
    );
    assertEquals(res.status, 502);
    assertEquals(tap.calls.length, 1);
  } finally {
    restoreFetch();
    clearSession();
  }

  withSession(SESSION_DID);
  try {
    const res = await handler(
      new Request("https://kipclip.com/api/sync/status"),
    );
    const body = await res.json();
    assertEquals(body.tracking, false);
  } finally {
    clearSession();
  }
});

Deno.test("POST /api/sync/track - 502 when TAP returns non-2xx", async () => {
  await clearMirrorTables();
  withSession(SESSION_DID);
  mockTapFetch([new Response("nope", { status: 500 })]);
  try {
    const res = await handler(
      new Request("https://kipclip.com/api/sync/track", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ did: SESSION_DID }),
      }),
    );
    assertEquals(res.status, 502);
  } finally {
    restoreFetch();
    clearSession();
  }
});

Deno.test("GET /api/sync/status - 401 when unauthenticated", async () => {
  clearSession();
  const res = await handler(
    new Request("https://kipclip.com/api/sync/status"),
  );
  assertEquals(res.status, 401);
});

Deno.test("GET /api/sync/status - returns tracking=false for untracked DID", async () => {
  await clearMirrorTables();
  withSession(SESSION_DID);
  try {
    const res = await handler(
      new Request("https://kipclip.com/api/sync/status"),
    );
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.tracking, false);
  } finally {
    clearSession();
  }
});

Deno.test("GET /api/sync/status - 403 when querying another DID", async () => {
  withSession(SESSION_DID);
  try {
    const res = await handler(
      new Request(`https://kipclip.com/api/sync/status?did=${OTHER_DID}`),
    );
    assertEquals(res.status, 403);
  } finally {
    clearSession();
  }
});

Deno.test("POST /api/sync/hook - 403 when URL hostname is not localhost", async () => {
  const res = await handler(
    new Request("https://kipclip.com/api/sync/hook", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ events: [] }),
    }),
  );
  assertEquals(res.status, 403);
});

// Auto-incrementing event id. The mirror's replay-protection layer
// (mirror/upserts.ts markWebhookEventSeen) dedupes by id, so distinct
// recordEvent() calls within a test must produce distinct ids.
// Tests that intentionally redeliver the same event capture the result
// of one recordEvent() call and reuse it.
let _nextEventId = 1;
function recordEvent(
  collection: string,
  rkey: string,
  action: "create" | "update" | "delete",
  record: Record<string, unknown> | undefined,
  cid?: string,
  live = false,
  did = SESSION_DID,
) {
  return {
    id: _nextEventId++,
    type: "record",
    record: {
      live,
      did,
      rev: "rev1",
      collection,
      rkey,
      action,
      record,
      cid,
    },
  };
}

Deno.test("POST /api/sync/hook - 200 when host is localhost (empty payload)", async () => {
  const res = await handler(
    new Request("http://127.0.0.1:8000/api/sync/hook", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: 0, type: "unknown" }),
    }),
  );
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.applied, false);
});

Deno.test("POST /api/sync/hook - 400 on malformed JSON", async () => {
  const res = await handler(
    new Request("http://127.0.0.1:8000/api/sync/hook", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not-json",
    }),
  );
  assertEquals(res.status, 400);
});

Deno.test("POST /api/sync/hook - applies bookmark create to mirror", async () => {
  await clearMirrorTables();
  const evt = recordEvent(
    "community.lexicon.bookmarks.bookmark",
    "abc",
    "create",
    {
      subject: "https://example.com/abc",
      createdAt: "2026-05-01T00:00:00.000Z",
      tags: ["news"],
    },
    "bafyABC",
  );
  const res = await handler(
    new Request("http://127.0.0.1:8000/api/sync/hook", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(evt),
    }),
  );
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.applied, true);
  assertEquals(body.type, "record");

  const { firstPageBookmarks } = await import("../mirror/queries.ts");
  const page = await firstPageBookmarks(SESSION_DID);
  assertEquals(page.bookmarks.length, 1);
  assertEquals(page.bookmarks[0].subject, "https://example.com/abc");
});

Deno.test("POST /api/sync/hook - applies delete event", async () => {
  await clearMirrorTables();
  const uri = `at://${SESSION_DID}/community.lexicon.bookmarks.bookmark/del`;
  await handler(
    new Request("http://127.0.0.1:8000/api/sync/hook", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(
        recordEvent(
          "community.lexicon.bookmarks.bookmark",
          "del",
          "create",
          {
            subject: "https://example.com/del",
            createdAt: "2026-05-01T00:00:00.000Z",
          },
          "bafyDel",
        ),
      ),
    }),
  );
  await handler(
    new Request("http://127.0.0.1:8000/api/sync/hook", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(
        recordEvent(
          "community.lexicon.bookmarks.bookmark",
          "del",
          "delete",
          undefined,
        ),
      ),
    }),
  );
  const { getBookmark } = await import("../mirror/queries.ts");
  assertEquals(await getBookmark(uri), null);
});

Deno.test("POST /api/sync/hook - duplicate redelivery is idempotent", async () => {
  await clearMirrorTables();
  const evt = recordEvent(
    "community.lexicon.bookmarks.bookmark",
    "dup",
    "create",
    {
      subject: "https://example.com/dup",
      createdAt: "2026-05-01T00:00:00.000Z",
    },
    "bafyDup",
  );
  const send = () =>
    handler(
      new Request("http://127.0.0.1:8000/api/sync/hook", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(evt),
      }),
    );
  await send();
  await send();
  const { firstPageBookmarks } = await import("../mirror/queries.ts");
  const page = await firstPageBookmarks(SESSION_DID);
  assertEquals(page.bookmarks.length, 1);
});

Deno.test("POST /api/sync/hook - bookmark + annotation + tag events fill mirror", async () => {
  await clearMirrorTables();
  const events = [
    recordEvent(
      "community.lexicon.bookmarks.bookmark",
      "m",
      "create",
      {
        subject: "https://example.com/m",
        createdAt: "2026-05-01T00:00:00.000Z",
      },
      "bafyB",
    ),
    recordEvent(
      "app.bookmark.annotation",
      "m",
      "create",
      {
        subject: `at://${SESSION_DID}/community.lexicon.bookmarks.bookmark/m`,
        note: "anno-note",
      },
      "bafyA",
    ),
    recordEvent(
      "com.kipclip.tag",
      "news",
      "create",
      { value: "news", createdAt: "2026-05-01T00:00:00.000Z" },
      "bafyT",
    ),
  ];
  for (const e of events) {
    const r = await handler(
      new Request("http://127.0.0.1:8000/api/sync/hook", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(e),
      }),
    );
    assertEquals(r.status, 200);
  }

  const { firstPageBookmarks, listTags } = await import(
    "../mirror/queries.ts"
  );
  const page = await firstPageBookmarks(SESSION_DID);
  assertEquals(page.bookmarks.length, 1);
  assertEquals(page.bookmarks[0].note, "anno-note");
  const tags = await listTags(SESSION_DID);
  assertEquals(tags.length, 1);
});

Deno.test("POST /api/sync/hook - live=true marks backfillCompleteAt", async () => {
  await clearMirrorTables();
  const evt = recordEvent(
    "community.lexicon.bookmarks.bookmark",
    "live1",
    "create",
    {
      subject: "https://example.com/live1",
      createdAt: "2026-05-01T00:00:00.000Z",
    },
    "bafyLive",
    /* live */ true,
  );
  const res = await handler(
    new Request("http://127.0.0.1:8000/api/sync/hook", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(evt),
    }),
  );
  assertEquals(res.status, 200);
  const { getSyncStatus } = await import("../mirror/queries.ts");
  const s = await getSyncStatus(SESSION_DID);
  assertEquals(s.tracking, true);
  assertEquals(typeof s.backfillCompleteAt, "number");
});

Deno.test("POST /api/sync/hook - identity event acks without writes", async () => {
  await clearMirrorTables();
  const res = await handler(
    new Request("http://127.0.0.1:8000/api/sync/hook", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: 99,
        type: "identity",
        identity: {
          did: SESSION_DID,
          handle: "tijs.org",
          is_active: true,
          status: "active",
        },
      }),
    }),
  );
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.applied, true);
});

Deno.test("POST /api/sync/hook - preferences create lands in mirror", async () => {
  await clearMirrorTables();
  const evt = recordEvent(
    "com.kipclip.preferences",
    "self",
    "create",
    { dateFormat: "iso", readingListTag: "later" },
    "bafyPref",
  );
  const res = await handler(
    new Request("http://127.0.0.1:8000/api/sync/hook", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(evt),
    }),
  );
  assertEquals(res.status, 200);
  const { getMirrorPreferences } = await import("../mirror/queries.ts");
  assertEquals(await getMirrorPreferences(SESSION_DID), {
    dateFormat: "iso",
    readingListTag: "later",
  });
});

Deno.test("POST /api/sync/hook - preferences update overwrites row", async () => {
  await clearMirrorTables();
  const send = (record: Record<string, unknown>, cid: string) =>
    handler(
      new Request("http://127.0.0.1:8000/api/sync/hook", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          recordEvent("com.kipclip.preferences", "self", "create", record, cid),
        ),
      }),
    );
  await send({ dateFormat: "us", readingListTag: "toread" }, "bafyP1");
  await send({ dateFormat: "iso", readingListTag: "later" }, "bafyP2");
  const { getMirrorPreferences } = await import("../mirror/queries.ts");
  assertEquals(await getMirrorPreferences(SESSION_DID), {
    dateFormat: "iso",
    readingListTag: "later",
  });
});

Deno.test("POST /api/sync/hook - preferences delete removes row", async () => {
  await clearMirrorTables();
  await handler(
    new Request("http://127.0.0.1:8000/api/sync/hook", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(
        recordEvent(
          "com.kipclip.preferences",
          "self",
          "create",
          { dateFormat: "us" },
          "bafyP1",
        ),
      ),
    }),
  );
  await handler(
    new Request("http://127.0.0.1:8000/api/sync/hook", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(
        recordEvent(
          "com.kipclip.preferences",
          "self",
          "delete",
          undefined,
        ),
      ),
    }),
  );
  const { getMirrorPreferences } = await import("../mirror/queries.ts");
  assertEquals(await getMirrorPreferences(SESSION_DID), null);
});

Deno.test("POST /api/sync/hook - TAP_WEBHOOK_SECRET unset → no auth required", async () => {
  await clearMirrorTables();
  Deno.env.delete("TAP_WEBHOOK_SECRET");
  const evt = recordEvent(
    "community.lexicon.bookmarks.bookmark",
    "noauth",
    "create",
    {
      subject: "https://example.com/noauth",
      createdAt: "2026-05-06T00:00:00.000Z",
    },
    "bafyNoAuth",
  );
  const r = await handler(
    new Request("http://127.0.0.1:8000/api/sync/hook", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(evt),
    }),
  );
  assertEquals(r.status, 200);
  assertEquals((await r.json()).applied, true);
});

Deno.test("POST /api/sync/hook - secret set + missing header → 401", async () => {
  Deno.env.set("TAP_WEBHOOK_SECRET", "test-secret-abc");
  try {
    const evt = recordEvent(
      "community.lexicon.bookmarks.bookmark",
      "missing",
      "create",
      {
        subject: "https://example.com/missing",
        createdAt: "2026-05-06T00:00:00.000Z",
      },
      "bafyMissing",
    );
    const r = await handler(
      new Request("http://127.0.0.1:8000/api/sync/hook", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(evt),
      }),
    );
    assertEquals(r.status, 401);
  } finally {
    Deno.env.delete("TAP_WEBHOOK_SECRET");
  }
});

Deno.test("POST /api/sync/hook - secret set + wrong bearer → 401", async () => {
  Deno.env.set("TAP_WEBHOOK_SECRET", "test-secret-abc");
  try {
    const evt = recordEvent(
      "community.lexicon.bookmarks.bookmark",
      "wrong",
      "create",
      {
        subject: "https://example.com/wrong",
        createdAt: "2026-05-06T00:00:00.000Z",
      },
      "bafyWrong",
    );
    const r = await handler(
      new Request("http://127.0.0.1:8000/api/sync/hook", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer not-the-secret",
        },
        body: JSON.stringify(evt),
      }),
    );
    assertEquals(r.status, 401);
  } finally {
    Deno.env.delete("TAP_WEBHOOK_SECRET");
  }
});

Deno.test("POST /api/sync/hook - secret set + correct bearer → 200", async () => {
  await clearMirrorTables();
  Deno.env.set("TAP_WEBHOOK_SECRET", "test-secret-abc");
  try {
    const evt = recordEvent(
      "community.lexicon.bookmarks.bookmark",
      "right",
      "create",
      {
        subject: "https://example.com/right",
        createdAt: "2026-05-06T00:00:00.000Z",
      },
      "bafyRight",
    );
    const r = await handler(
      new Request("http://127.0.0.1:8000/api/sync/hook", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer test-secret-abc",
        },
        body: JSON.stringify(evt),
      }),
    );
    assertEquals(r.status, 200);
    assertEquals((await r.json()).applied, true);
  } finally {
    Deno.env.delete("TAP_WEBHOOK_SECRET");
  }
});

Deno.test("POST /api/sync/hook - replayed event is rejected (replayed:true)", async () => {
  await clearMirrorTables();
  const evt = recordEvent(
    "community.lexicon.bookmarks.bookmark",
    "rep1",
    "create",
    {
      subject: "https://example.com/replay",
      createdAt: "2026-05-06T00:00:00.000Z",
    },
    "bafyRep1",
  );
  // First delivery: applied:true.
  const r1 = await handler(
    new Request("http://127.0.0.1:8000/api/sync/hook", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(evt),
    }),
  );
  assertEquals((await r1.json()).applied, true);

  // Second delivery of the SAME event id: replayed:true, applied:false.
  // Without replay protection, an attacker capturing this event's payload
  // could re-deliver a delete after the user re-created the record.
  const r2 = await handler(
    new Request("http://127.0.0.1:8000/api/sync/hook", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(evt),
    }),
  );
  const body2 = await r2.json();
  assertEquals(r2.status, 200);
  assertEquals(body2.applied, false);
  assertEquals(body2.replayed, true);
  assertEquals(body2.id, evt.id);
});
