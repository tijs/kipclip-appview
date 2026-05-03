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
    if (url.startsWith("http://127.0.0.1:7000")) {
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
    assertEquals(tap.calls[0].url, "http://127.0.0.1:7000/admin/track");
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

Deno.test("POST /api/sync/hook - 200 when host is localhost", async () => {
  const res = await handler(
    new Request("http://127.0.0.1:8000/api/sync/hook", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ events: [] }),
    }),
  );
  assertEquals(res.status, 200);
});
