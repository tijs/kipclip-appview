import "../runtime/deno/install.ts";
import "./test-setup.ts";
import { assert, assertEquals } from "@std/assert";
import { db } from "../lib/db.ts";
import { broadcastToDid } from "../routes/api/live.ts";
import { assertIsolated, assertSecurity } from "./migration/isolation.ts";
import {
  cookieManager,
  fixtureDid,
  withOAuthBoundary,
} from "./migration/oauth-fixture.ts";
import {
  barrier,
  countSockets,
  withLiveServer,
} from "./migration/live-fixture.ts";

assertIsolated();
const realFetch = globalThis.fetch;
const cookie = async () =>
  (await cookieManager().createSession({
    did: fixtureDid,
    createdAt: Date.now(),
    lastAccessed: Date.now(),
  })).split(";")[0];

Deno.test("migration actual baseline/Deno WebSocket HTTP negotiation rejects missing upgrade/auth/corrupt cookie", async () => {
  await withLiveServer(async ({ origin, intervals }) => {
    for (
      const [headers, status, body] of [
        [{}, 400, "Expected WebSocket upgrade"],
        [{ upgrade: "websocket" }, 401, "Unauthorized"],
        [{ upgrade: "websocket", cookie: "sid=corrupt" }, 401, "Unauthorized"],
      ] as const
    ) {
      const res = await realFetch(`${origin}/api/live`, { headers });
      assertEquals(res.status, status);
      assertEquals(await res.text(), body);
      assertEquals(res.headers.get("sec-websocket-accept"), null);
      assertSecurity(res);
    }
    assertEquals(intervals.size, 0);
  });
});

Deno.test("migration actual baseline/Deno WebSocket encrypted cookie auth, 101 headers and DID fanout", async () => {
  await withOAuthBoundary(async (calls) => {
    await withLiveServer(async ({ connect, tick, intervals }) => {
      const a = await connect(await cookie());
      const b = await connect(await cookie());
      assertEquals(a.handshake.status, 101);
      assertEquals(a.handshake.headers.upgrade, "websocket");
      assertEquals(a.handshake.headers.connection.toLowerCase(), "upgrade");
      assert(typeof a.handshake.headers["sec-websocket-accept"] === "string");
      assertEquals(a.handshake.headers["x-frame-options"], "DENY");
      // Existing upgrade ignores the cookie refresh generated during auth.
      assertEquals(a.handshake.headers["set-cookie"], undefined);
      assertEquals(calls.restore, [fixtureDid, fixtureDid]);
      assertEquals(countSockets(fixtureDid), 2);
      assertEquals(intervals.size, 2);
      const event = {
        type: "record" as const,
        collection: "com.kipclip.tag",
        rkey: "fixture",
        op: "create" as const,
        indexedAt: 42,
      };
      broadcastToDid(fixtureDid, event);
      assertEquals(await a.nextMessage(), { ...event, did: fixtureDid });
      assertEquals(await b.nextMessage(), { ...event, did: fixtureDid });
      broadcastToDid("did:plc:otherfixture", event);
      // Ordered heartbeat barrier confirms there was no cross-DID event.
      tick();
      assertEquals(await a.nextMessage(), { type: "ping" });
      assertEquals(await b.nextMessage(), { type: "ping" });
    });
    assertEquals(countSockets(fixtureDid), 0);
  });
});

Deno.test("migration actual baseline/Deno heartbeat closes on third tick after two missed pongs", async () => {
  await withOAuthBoundary(async () => {
    await withLiveServer(async ({ connect, tick, intervals }) => {
      const client = await connect(await cookie());
      await barrier(client, tick);
      await barrier(client, tick);
      tick();
      assertEquals(await client.closed, { code: 1011, reason: "missed pong" });
      assertEquals(countSockets(fixtureDid), 0);
      assertEquals(intervals.size, 0);
      assertEquals(client.messages, [{ type: "ping" }, { type: "ping" }]);
    });
  });
});

Deno.test("migration actual baseline/Deno pong resets missed count; malformed and binary messages do not", async () => {
  await withOAuthBoundary(async () => {
    await withLiveServer(async ({ connect, tick }) => {
      const client = await connect(await cookie());
      await barrier(client, tick);
      await barrier(client, tick);
      const flushInput = async () => {
        let timer: number;
        try {
          await new Promise<void>((resolve, reject) => {
            timer = setTimeout(
              () => reject(new Error("Control pong timeout")),
              3000,
            );
            client.socket.once("pong", () => resolve());
            client.socket.ping();
          });
        } finally {
          clearTimeout(timer);
        }
      };
      client.socket.send(JSON.stringify({ type: "pong" }));
      await flushInput();
      await barrier(client, tick); // Would close here without reset.
      client.socket.send("not-json");
      client.socket.send(JSON.stringify({ type: "record" }));
      client.socket.send(new Uint8Array([0, 1, 255]));
      await flushInput();
      await barrier(client, tick);
      tick();
      assertEquals(await client.closed, { code: 1011, reason: "missed pong" });
      assertEquals(client.messages.length, 4);
    });
  });
});

Deno.test("migration actual webhook → SQLite → WebSocket wire events, replay and current event policy", async () => {
  await withOAuthBoundary(async () => {
    await withLiveServer(async ({ origin, connect, tick }) => {
      const client = await connect(await cookie());
      const post = (body: unknown) =>
        realFetch(`${origin}/api/sync/hook`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
      const event = {
        id: 900001,
        type: "record",
        record: {
          did: fixtureDid,
          live: true,
          collection: "community.lexicon.bookmarks.bookmark",
          rkey: "migration-wire",
          action: "create",
          cid: "fixture-cid",
          record: {
            subject: "https://example.com/fixture",
            createdAt: "2026-01-01T00:00:00.000Z",
            tags: ["news"],
          },
        },
      };
      const response = await post(event);
      assertEquals(response.status, 200);
      assertSecurity(response);
      assertEquals(await response.json(), {
        id: event.id,
        type: "record",
        applied: true,
      });
      const message = await client.nextMessage();
      assertEquals({ ...message, indexedAt: 0 }, {
        did: fixtureDid,
        type: "record",
        collection: event.record.collection,
        rkey: "migration-wire",
        op: "create",
        indexedAt: 0,
      });
      assert(typeof message.indexedAt === "number");
      const rows = await db.execute({
        sql: "SELECT subject FROM bookmarks WHERE uri = ?",
        args: [`at://${fixtureDid}/${event.record.collection}/migration-wire`],
      });
      assertEquals(rows.rows, [["https://example.com/fixture"]]);
      assertEquals(await (await post(event)).json(), {
        id: event.id,
        type: "record",
        applied: false,
        replayed: true,
      });
      assertEquals(
        await (await post({ type: "identity", identity: { did: fixtureDid } }))
          .json(),
        { type: "identity", applied: true },
      );
      assertEquals(await (await post({ type: "unknown" })).json(), {
        type: "unknown",
        applied: false,
      });
      await barrier(client, tick); // Those three requests do not broadcast.
      // Preserve the existing distinction between storage filtering and wire
      // filtering: unknown collections are ignored by storage but broadcast.
      const ignored = {
        type: "record",
        record: {
          ...event.record,
          collection: "com.example.unknown",
          rkey: "ignored",
        },
      };
      assertEquals((await (await post(ignored)).json()).applied, true);
      assertEquals(
        (await client.nextMessage()).collection,
        "com.example.unknown",
      );
      const invalid = await post({
        type: "record",
        record: { ...event.record, did: "invalid-did" },
      });
      assertEquals(invalid.status, 500);
      assertEquals(await invalid.json(), {
        error: "Invalid did in record event",
      });
      await barrier(client, tick); // Failed upsert does not broadcast.
    });
    assertEquals(countSockets(fixtureDid), 0);
  });
});
