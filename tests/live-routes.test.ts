/**
 * Tests for routes/api/live.ts — WebSocket upgrade + DID socket registry +
 * broadcastToDid fan-out. Real WebSocket upgrades require a live Deno.serve
 * loop; these tests cover the parts that are reachable through the handler
 * (auth gates, upgrade negotiation) and the registry/broadcast contract via
 * mock sockets injected with the `_addSocketForTest` hook.
 */

import "./test-setup.ts";

import { assertEquals } from "@std/assert";
import { app } from "../main.ts";
import { initOAuth } from "../lib/oauth-config.ts";
import { setTestSessionProvider } from "../lib/session.ts";
import { createMockSessionResult, createMockSocket } from "./test-helpers.ts";
import {
  _addSocketForTest,
  _cleanupSocketForTest,
  _clearSocketsForTest,
  _liveSocketCountForTest,
  broadcastToDid,
  type LiveEvent,
} from "../routes/api/live.ts";

initOAuth(new URL("https://kipclip.com"));
const handler = app.handler();

const SESSION_DID = "did:plc:test123";

function withSession(did: string = SESSION_DID) {
  setTestSessionProvider(() =>
    Promise.resolve(createMockSessionResult({ did }))
  );
}

function clearSession() {
  setTestSessionProvider(null);
}


Deno.test("GET /api/live - 400 when upgrade header missing", async () => {
  withSession();
  try {
    const res = await handler(
      new Request("http://127.0.0.1:8000/api/live", { method: "GET" }),
    );
    assertEquals(res.status, 400);
    await res.body?.cancel();
  } finally {
    clearSession();
  }
});

Deno.test("GET /api/live - 401 when unauthenticated", async () => {
  clearSession();
  const res = await handler(
    new Request("http://127.0.0.1:8000/api/live", {
      method: "GET",
      headers: { upgrade: "websocket" },
    }),
  );
  assertEquals(res.status, 401);
  await res.body?.cancel();
});

Deno.test("broadcastToDid - no-op when no sockets registered", () => {
  _clearSocketsForTest();
  broadcastToDid("did:plc:nope", { type: "record", collection: "x" });
  assertEquals(_liveSocketCountForTest("did:plc:nope"), 0);
});

Deno.test("broadcastToDid - delivers payload to all open sockets for a DID", () => {
  _clearSocketsForTest();
  const a = createMockSocket();
  const b = createMockSocket();
  _addSocketForTest(SESSION_DID, a as unknown as WebSocket);
  _addSocketForTest(SESSION_DID, b as unknown as WebSocket);

  const event: LiveEvent = {
    type: "record",
    collection: "com.kipclip.tag",
    rkey: "abc",
    op: "create",
    indexedAt: 12345,
  };
  broadcastToDid(SESSION_DID, event);

  assertEquals(a.sent.length, 1);
  assertEquals(b.sent.length, 1);
  // broadcastToDid stamps `did` onto every payload, so the wire shape is
  // event ∪ { did: SESSION_DID }.
  assertEquals(JSON.parse(a.sent[0]), { ...event, did: SESSION_DID });
  assertEquals(JSON.parse(b.sent[0]), { ...event, did: SESSION_DID });

  _clearSocketsForTest();
});

Deno.test("broadcastToDid - skips closed sockets without throwing", () => {
  _clearSocketsForTest();
  const open = createMockSocket(true);
  const closed = createMockSocket(false);
  _addSocketForTest(SESSION_DID, open as unknown as WebSocket);
  _addSocketForTest(SESSION_DID, closed as unknown as WebSocket);

  broadcastToDid(SESSION_DID, { type: "record" });

  assertEquals(open.sent.length, 1);
  assertEquals(closed.sent.length, 0);

  _clearSocketsForTest();
});

Deno.test("broadcastToDid - DID isolation: socket on DID-A does not receive DID-B events", () => {
  _clearSocketsForTest();
  const a = createMockSocket();
  const b = createMockSocket();
  _addSocketForTest("did:plc:aaa", a as unknown as WebSocket);
  _addSocketForTest("did:plc:bbb", b as unknown as WebSocket);

  broadcastToDid("did:plc:aaa", { type: "record" });

  assertEquals(a.sent.length, 1);
  assertEquals(b.sent.length, 0);

  _clearSocketsForTest();
});

Deno.test("cleanup - removes socket from per-DID registry", () => {
  _clearSocketsForTest();
  const sock = createMockSocket();
  _addSocketForTest(SESSION_DID, sock as unknown as WebSocket);
  assertEquals(_liveSocketCountForTest(SESSION_DID), 1);

  _cleanupSocketForTest(sock as unknown as WebSocket);
  assertEquals(_liveSocketCountForTest(SESSION_DID), 0);

  _clearSocketsForTest();
});

Deno.test("cleanup - is idempotent (close-after-error path)", () => {
  _clearSocketsForTest();
  const sock = createMockSocket();
  _addSocketForTest(SESSION_DID, sock as unknown as WebSocket);

  // Simulate the runtime firing both `error` and then `close` for the same
  // socket — both call cleanupSocket. The second call must be a no-op
  // (no throw, no negative count).
  _cleanupSocketForTest(sock as unknown as WebSocket);
  _cleanupSocketForTest(sock as unknown as WebSocket);
  assertEquals(_liveSocketCountForTest(SESSION_DID), 0);

  _clearSocketsForTest();
});

Deno.test("cleanup - one socket of a multi-socket DID does not clobber the others", () => {
  _clearSocketsForTest();
  const a = createMockSocket();
  const b = createMockSocket();
  _addSocketForTest(SESSION_DID, a as unknown as WebSocket);
  _addSocketForTest(SESSION_DID, b as unknown as WebSocket);
  assertEquals(_liveSocketCountForTest(SESSION_DID), 2);

  _cleanupSocketForTest(a as unknown as WebSocket);
  assertEquals(_liveSocketCountForTest(SESSION_DID), 1);

  // Remaining socket still receives broadcasts.
  broadcastToDid(SESSION_DID, { type: "record" });
  assertEquals(a.sent.length, 0);
  assertEquals(b.sent.length, 1);

  _clearSocketsForTest();
});
