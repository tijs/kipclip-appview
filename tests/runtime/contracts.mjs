/** Identical isolated contract suite under Deno, Bun and Node. No test framework shim. */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import WebSocket from "ws";
import { caseRequest, routeCases } from "../migration/route-cases.ts";
import { observe } from "../migration/contracts.ts";

Object.assign(process.env, {
  SENTRY_DSN: "",
  KIPCLIP_TESTING: "1",
  KIPCLIP_MANIFEST_PATH: "tests/fixtures/manifest.test.json",
  DATABASE_URL: "file::memory:",
  COOKIE_SECRET: "test-cookie-secret-32-characters-minimum",
  ENCRYPTION_KEY: "test-encryption-key-for-unit-tests-only-minimum-32-chars",
  BASE_URL: "https://migration.example",
  MIRROR_MODE: "off",
  TAP_ADMIN_PASSWORD: "fixture-only",
  HOST: "127.0.0.1",
});
const runtime = typeof Deno !== "undefined"
  ? "deno"
  : typeof Bun !== "undefined"
  ? "bun"
  : "node";
const nativeFetch = globalThis.fetch;
let shareFixture = false;
const attemptedExternal = [];
globalThis.fetch = (input, init) => {
  const url = new URL(
    typeof input === "string" || input instanceof URL ? input : input.url,
  );
  if (
    shareFixture && url.origin === "https://migration.example" &&
    url.pathname.startsWith("/api/share/")
  ) {
    return Promise.resolve(
      Response.json({ handle: 'alice<"example>', bookmarks: [{}] }),
    );
  }
  if (url.hostname !== "127.0.0.1") {
    attemptedExternal.push(url.href);
    throw new Error("External request forbidden: " + url.href);
  }
  return nativeFetch(input, init);
};
const adapter = await import(
  runtime === "deno"
    ? "../../runtime/deno/server.ts"
    : `../../runtime/${runtime}/server.mjs`
);
const started = await adapter.startServer({ port: 0 });
const { core, host, origin } = started;
const handler = core.app.handler();
const info = {
  remoteAddr: { hostname: "127.0.0.1", port: 12345, transport: "tcp" },
};
const observations = [];
const failures = [];
async function test(name, run) {
  try {
    await run();
    observations.push(name);
    console.log("PASS " + name);
  } catch (error) {
    failures.push({ name, message: String(error), stack: error.stack });
    console.error("FAIL " + name, error);
  }
}
const security = {
  "x-frame-options": "DENY",
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
  "strict-transport-security": "max-age=31536000; includeSubDomains",
  "permissions-policy": "camera=(), microphone=(), geolocation=()",
};
function checkSecurity(headers) {
  for (const [name, value] of Object.entries(security)) {
    assert.equal(headers.get(name), value, name);
  }
}
const manager = new core.SessionManager({
  cookieSecret: process.env.COOKIE_SECRET,
  cookieName: "sid",
  sessionTtl: 1209600,
});
const did = "did:plc:migrationfixture";
const savedOAuth = {};
let cookie;
const clients = [];
const intervals = new Map();
const originalInterval = globalThis.setInterval;
const originalClear = globalThis.clearInterval;
let intervalId = -100;
function tick() {
  for (const fn of [...intervals.values()]) fn();
}
function bounded(promise) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("WS timeout")), 3000);
    }),
  ]).finally(() => clearTimeout(timer));
}
async function connect(pair) {
  const socket = new WebSocket(origin.replace("http:", "ws:") + "/api/live", {
    headers: pair ? { cookie: pair } : {},
  });
  const messages = [], queue = [], pending = [];
  let upgrade;
  const closed = new Promise((resolve) =>
    socket.once(
      "close",
      (code, reason) => resolve({ code, reason: reason.toString() }),
    )
  );
  socket.on("upgrade", (response) => {
    upgrade = response;
  });
  socket.on("message", (bytes) => {
    const value = JSON.parse(bytes.toString());
    messages.push(value);
    const resolve = pending.shift();
    if (resolve) resolve(value);
    else queue.push(value);
  });
  clients.push({ socket, closed });
  await bounded(
    new Promise((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
      socket.once("unexpected-response", (_request, response) => {
        response.resume();
        reject(new Error("Upgrade rejected " + response.statusCode));
      });
    }),
  );
  return {
    socket,
    closed,
    upgrade,
    messages,
    next: () =>
      queue.length
        ? Promise.resolve(queue.shift())
        : bounded(new Promise((resolve) => pending.push(resolve))),
  };
}
try {
  const baseline = JSON.parse(
    await readFile(
      new URL("../fixtures/migration-route-baseline.json", import.meta.url),
      "utf8",
    ),
  );
  assert.equal(Object.keys(baseline).length, routeCases.length);
  for (const entry of routeCases) {
    await test("recorded route: " + entry.name, async () => {
      assert.deepEqual(
        await observe(await handler(caseRequest(entry), info)),
        baseline[entry.name],
      );
    });
  }
  await test("host/runtime/filesystem/native SQLite startup", async () => {
    assert.equal(host.process.runtime, runtime);
    assert(host.process.version);
    assert(
      (await host.readFile(new URL("../../static/sw.js", import.meta.url)))
        .byteLength > 0,
    );
    const rows = (await core.db.execute({
      sql: "SELECT version FROM migrations ORDER BY version",
      args: [],
    })).rows;
    assert.equal(rows.length, 14);
  });
  await test("native SQLite file persistence/close/reopen", async () => {
    const root = await mkdtemp(
      join(process.env.TMPDIR, "kipclip-native-sqlite-"),
    );
    let client;
    try {
      client = host.createDatabase({ url: "file:" + join(root, "fixture.db") });
      await client.execute("CREATE TABLE fixture (value TEXT)");
      await client.execute({
        sql: "INSERT INTO fixture VALUES (?)",
        args: ["fixture"],
      });
      client.close();
      client = host.createDatabase({ url: "file:" + join(root, "fixture.db") });
      assert.equal(
        (await client.execute("SELECT value FROM fixture")).rows[0].value,
        "fixture",
      );
    } finally {
      client?.close();
      await rm(root, { recursive: true, force: true });
    }
  });
  await test("native Sentry SDK custom transport remains offline", async () => {
    const envelopes = [];
    host.sentry.init({
      dsn: "https://fixture@example.invalid/1",
      defaultIntegrations: false,
      autoSessionTracking: false,
      transport: () => ({
        send: (envelope) => {
          envelopes.push(envelope);
          return Promise.resolve({ statusCode: 200 });
        },
        flush: () => Promise.resolve(true),
      }),
    });
    try {
      host.sentry.captureMessage("isolated-sdk-fixture");
      await host.sentry.flush(2000);
      assert.equal(envelopes.length, 1);
    } finally {
      await host.sentry.close(2000);
    }
  });
  await test("actual server health/static/SPA/exclusions/security", async () => {
    for (
      const path of [
        "/api/health",
        "/api/health/",
        "/",
        "/deep/spa/page",
        "/api/no-route",
        "/oauth/no-route",
        "/login-other",
        "/static/sw.js",
      ]
    ) {
      const response = await fetch(origin + path);
      assert.equal(
        response.status,
        ["/api/no-route", "/oauth/no-route", "/login-other"].includes(path)
          ? 404
          : 200,
      );
      checkSecurity(response.headers);
      await response.arrayBuffer();
    }
  });
  await test("static binary bytes/cache/root alias conditional HEAD", async () => {
    const expected = new Uint8Array(
      await readFile(new URL("../../static/sw.js", import.meta.url)),
    );
    const response = await fetch(origin + "/sw.js");
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), expected);
    const etag = response.headers.get("etag");
    assert(etag);
    assert.equal(
      (await fetch(origin + "/sw.js", { headers: { "if-none-match": etag } }))
        .status,
      304,
    );
    const head = await fetch(origin + "/sw.js", { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal((await head.arrayBuffer()).byteLength, 0);
    const manifestPath = new URL("../../static/manifest.json", import.meta.url);
    try {
      const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
      const asset = await fetch(origin + "/static/" + manifest["bundle.js"]);
      assert.equal(asset.status, 200);
      assert.equal(
        asset.headers.get("cache-control"),
        "public, max-age=31536000, immutable",
      );
      assert.equal(
        "sha384-" +
          createHash("sha384").update(new Uint8Array(await asset.arrayBuffer()))
            .digest("base64"),
        manifest.integrity,
      );
    } catch (error) {
      if (
        error.code !== "ENOENT" ||
        process.env.KIPCLIP_REQUIRE_BUILT_ASSETS === "1"
      ) throw error;
    }
  });
  await test("share metadata escaping with strict self-fetch fixture", async () => {
    shareFixture = true;
    try {
      const tags = ['tag<"test>'];
      const encoded = core.encodeTagsForUrl(tags);
      const response = await handler(
        new Request(`https://migration.example/share/${did}/${encoded}`),
        info,
      );
      const html = await response.text();
      assert.equal(response.status, 200);
      assert(html.includes("alice&lt;&quot;example&gt;"));
      assert(html.includes("tag&lt;&quot;test&gt;"));
      assert(html.includes('rel="alternate"'));
    } finally {
      shareFixture = false;
    }
  });
  const fixtureSession = {
    did,
    handle: "alice.example",
    pdsUrl: "",
    toJSON: () => ({ did, fixture: true }),
    makeRequest: (_method, endpoint) =>
      Promise.resolve(
        endpoint.includes("getRecord")
          ? Response.json({ error: "RecordNotFound" }, { status: 404 })
          : Response.json({ records: [] }),
      ),
  };
  for (const name of ["authorize", "callback", "restore"]) {
    savedOAuth[name] = core.OAuthClient.prototype[name];
  }
  core.OAuthClient.prototype.authorize = () =>
    Promise.resolve(new URL("https://auth.example/authorize?fixture=true"));
  core.OAuthClient.prototype.callback = (params) =>
    Promise.resolve({ session: fixtureSession, state: params.get("state") });
  core.OAuthClient.prototype.restore = () => Promise.resolve(fixtureSession);
  await test("background worker singleton scheduling and owned stop", () => {
    let scheduled = 0, cleared = 0;
    const set = globalThis.setInterval, clear = globalThis.clearInterval;
    try {
      delete process.env.KIPCLIP_TESTING;
      globalThis.setInterval = (_callback, delay) => {
        assert.equal(delay, 60000);
        scheduled++;
        return -991;
      };
      globalThis.clearInterval = (id) => {
        assert.equal(id, -991);
        cleared++;
      };
      core.worker.startPreviewEnrichmentWorker();
      core.worker.startPreviewEnrichmentWorker();
      assert.equal(scheduled, 1);
      core.worker.stopPreviewEnrichmentWorker();
      assert.equal(cleared, 1);
    } finally {
      process.env.KIPCLIP_TESTING = "1";
      globalThis.setInterval = set;
      globalThis.clearInterval = clear;
    }
  });
  await test("actual OAuth login redirect without provider contact", async () => {
    const response = await fetch(origin + "/login?handle=alice.example", {
      redirect: "manual",
    });
    assert.equal(response.status, 302);
    assert.equal(
      response.headers.get("location"),
      "https://auth.example/authorize?fixture=true",
    );
    checkSecurity(response.headers);
  });
  await test("actual callback encrypted Set-Cookie/WebCrypto/SQLite TTL", async () => {
    const state = encodeURIComponent(
      JSON.stringify({ handle: "alice.example", redirectPath: "/save" }),
    );
    const response = await fetch(
      origin + `/oauth/callback?code=fixture&state=${state}`,
      { redirect: "manual" },
    );
    assert.equal(response.status, 302);
    cookie = response.headers.get("set-cookie");
    assert(cookie && !cookie.includes(did));
    assert.deepEqual(cookie.split("; ").slice(1), [
      "Path=/",
      "HttpOnly",
      "SameSite=Lax",
      "Secure",
      "Max-Age=1209600",
    ]);
    cookie = cookie.split(";")[0];
    const decoded = await manager.getSessionFromRequest(
      new Request("https://migration.example", { headers: { cookie } }),
    );
    assert.equal(decoded.data.did, did);
    const rows = (await core.db.execute({
      sql:
        "SELECT key,value,expires_at FROM iron_session_storage WHERE key = ?",
      args: ["session:" + did],
    })).rows;
    assert.equal(rows.length, 1);
    assert.equal(JSON.parse(rows[0][1]).did, did);
    assert(Number(rows[0][2]) > Date.now());
    checkSecurity(response.headers);
  });
  await test("actual authenticated session refresh and settings persistence", async () => {
    const response = await fetch(origin + "/api/auth/session", {
      headers: { cookie },
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).did, did);
    assert(response.headers.get("set-cookie"));
    const update = await fetch(origin + "/api/settings", {
      method: "PATCH",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ viewMode: "compact" }),
    });
    assert.equal(update.status, 200);
    await update.arrayBuffer();
    assert.equal(
      (await core.db.execute({
        sql: "SELECT COUNT(*) FROM user_settings WHERE did = ?",
        args: [did],
      })).rows[0][0],
      1,
    );
  });
  await test("actual WebSocket failed-auth transport401", async () => {
    const request = new WebSocket(origin.replace("http:", "ws:") + "/api/live");
    await bounded(
      new Promise((resolve, reject) => {
        request.once("unexpected-response", (_req, response) => {
          assert.equal(response.statusCode, 401);
          response.resume();
          request.terminate();
          resolve();
        });
        request.once(
          "open",
          () => reject(new Error("Unauthenticated upgrade accepted")),
        );
        request.on("error", () => {});
      }),
    );
  });
  globalThis.setInterval = (callback, delay, ...args) => {
    if (delay !== 30000) return originalInterval(callback, delay, ...args);
    intervals.set(--intervalId, callback);
    return intervalId;
  };
  globalThis.clearInterval = (timer) => {
    if (!intervals.delete(timer)) originalClear(timer);
  };
  await test("actual WebSocket101/security/no-refresh/heartbeat/pong/fanout/filter", async () => {
    const first = await connect(cookie);
    const second = await connect(cookie);
    assert.equal(first.upgrade.statusCode, 101);
    for (const [name, value] of Object.entries(security)) {
      assert.equal(first.upgrade.headers[name], value, name);
    }
    assert.equal(first.upgrade.headers["set-cookie"], undefined);
    assert.equal(first.upgrade.headers["sec-websocket-protocol"], undefined);
    assert.equal(core.live._liveSocketCountForTest(did), 2);
    core.live.broadcastToDid("did:plc:otherfixture", {
      type: "record",
      collection: "com.kipclip.tag",
      rkey: "nope",
      indexedAt: 1,
    });
    tick();
    assert.deepEqual(await first.next(), { type: "ping" });
    assert.deepEqual(await second.next(), { type: "ping" });
    first.socket.send('{"type":"pong"}');
    second.socket.send('{"type":"pong"}');
    // A record broadcast is an ordered wire barrier, not a sleep assertion.
    core.live.broadcastToDid(did, {
      type: "record",
      collection: "com.kipclip.tag",
      rkey: "fixture",
      indexedAt: 42,
    });
    const a = await first.next();
    const b = await second.next();
    assert.deepEqual(a, b);
    assert.equal(a.rkey, "fixture");
    first.socket.close(1000);
    second.socket.close(1000);
    await bounded(Promise.all([first.closed, second.closed]));
  });
  await test("actual WebSocket pong reset and ignored malformed/binary frames", async () => {
    const client = await connect(cookie);
    async function wireBarrier() {
      const pong = bounded(
        new Promise((resolve) => client.socket.once("pong", resolve)),
      );
      client.socket.ping();
      await pong;
    }
    tick();
    await client.next();
    tick();
    await client.next();
    client.socket.send('{"type":"pong"}');
    await wireBarrier();
    tick();
    assert.deepEqual(await client.next(), { type: "ping" });
    client.socket.send("malformed");
    client.socket.send(new Uint8Array([0, 255]));
    await wireBarrier();
    tick();
    assert.deepEqual(await client.next(), { type: "ping" });
    tick();
    assert.deepEqual(await bounded(client.closed), {
      code: 1011,
      reason: "missed pong",
    });
  });
  await test("actual webhook/SQLite/WS effects, dedupe and event filtering", async () => {
    const client = await connect(cookie);
    const post = (data) =>
      fetch(origin + "/api/sync/hook", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer fixture-only",
        },
        body: JSON.stringify(data),
      });
    const event = {
      id: 900001,
      type: "record",
      record: {
        did,
        live: true,
        collection: "community.lexicon.bookmarks.bookmark",
        rkey: "runtime-wire",
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
    assert.equal(response.status, 200);
    assert.equal((await response.json()).applied, true);
    assert.equal((await client.next()).rkey, "runtime-wire");
    assert.deepEqual(
      (await core.db.execute({
        sql: "SELECT subject FROM bookmarks WHERE uri = ?",
        args: [`at://${did}/${event.record.collection}/runtime-wire`],
      })).rows,
      [["https://example.com/fixture"]],
    );
    assert.equal((await (await post(event)).json()).replayed, true);
    await (await post({ type: "identity", identity: { did } })).arrayBuffer();
    await (await post({ type: "unknown" })).arrayBuffer();
    tick();
    assert.deepEqual(await client.next(), { type: "ping" });
    const ignored = {
      type: "record",
      record: {
        ...event.record,
        collection: "com.example.unknown",
        rkey: "ignored",
      },
    };
    assert.equal((await (await post(ignored)).json()).applied, true);
    assert.equal((await client.next()).collection, "com.example.unknown");
    client.socket.close(1000);
    await bounded(client.closed);
  });
  await test("actual WebSocket missed-pong third-tick1011 and cleanup", async () => {
    const client = await connect(cookie);
    tick();
    assert.deepEqual(await client.next(), { type: "ping" });
    tick();
    assert.deepEqual(await client.next(), { type: "ping" });
    tick();
    assert.deepEqual(await bounded(client.closed), {
      code: 1011,
      reason: "missed pong",
    });
    assert.equal(core.live._liveSocketCountForTest(did), 0);
    assert.equal(intervals.size, 0);
  });
  await test("actual logout cookie and session-storage deletion", async () => {
    const response = await fetch(origin + "/api/auth/logout", {
      method: "POST",
      headers: { cookie },
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { success: true });
    assert.equal(
      response.headers.get("set-cookie"),
      "sid=; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=0",
    );
    assert.equal(
      (await core.db.execute({
        sql: "SELECT key FROM iron_session_storage WHERE key = ?",
        args: ["session:" + did],
      })).rows.length,
      0,
    );
  });
  await test("zero unexpected external/customer requests", () => {
    assert.deepEqual(attemptedExternal, []);
  });
  await test("owned adapter stop is idempotent and closes listening socket", async () => {
    await started.stop();
    await started.stop();
    await assert.rejects(() => fetch(origin + "/api/health"));
    assert.equal(core.live._liveSocketCountForTest(did), 0);
    assert.equal(intervals.size, 0);
  });
} finally {
  for (const { socket } of clients) {
    if (socket.readyState !== WebSocket.CLOSED) socket.terminate();
  }
  Object.assign(core.OAuthClient.prototype, savedOAuth);
  globalThis.setInterval = originalInterval;
  globalThis.clearInterval = originalClear;
  await started.stop();
  globalThis.fetch = nativeFetch;
}
console.log(
  "RUNTIME_RESULT " +
    JSON.stringify({
      runtime,
      version: host.process.version,
      passed: observations.length,
      failed: failures.length,
      names: observations,
      failures,
    }),
);
if (failures.length) process.exitCode = 1;
