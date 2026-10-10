import "../runtime/deno/install.ts";
import "./test-setup.ts";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { IssuerMismatchError } from "@tijs/oauth-client-deno";
import { app } from "../main.ts";
import { db } from "../lib/db.ts";
import { assertIsolated, assertSecurity } from "./migration/isolation.ts";
import {
  assertEncryptedCookie,
  cookieManager,
  fixtureDid,
  fixtureSession,
  withOAuthBoundary,
} from "./migration/oauth-fixture.ts";

assertIsolated();
const handler = app.handler();
const origin = "https://migration.example";
const callbackUrl = (state: unknown) =>
  `${origin}/oauth/callback?code=fixture-code&state=${
    encodeURIComponent(JSON.stringify(state))
  }`;
const sessionRow = () =>
  db.execute({
    sql: "SELECT value, expires_at FROM iron_session_storage WHERE key = ?",
    args: [`session:${fixtureDid}`],
  });

for (
  const [query, body] of [
    ["", "Invalid handle"],
    ["?handle=", "Invalid handle"],
    ["?handle=bad%20handle", "Invalid handle format"],
  ]
) {
  Deno.test(`migration login invalid input ${query}`, async () => {
    await withOAuthBoundary(async (calls) => {
      const res = await handler(new Request(`${origin}/login${query}`));
      assertEquals(res.status, 400);
      assertEquals(await res.text(), body);
      assertEquals(res.headers.get("location"), null);
      assertEquals(res.headers.get("set-cookie"), null);
      assertSecurity(res);
      assertEquals(calls.authorize, []);
    });
  });
}

for (
  const redirect of [
    "/save?url=https%3A%2F%2Fexample.com",
    "//evil.example",
    "https://evil.example",
    "",
  ]
) {
  Deno.test(`migration login redirect validation ${redirect || "default"}`, async () => {
    await withOAuthBoundary(async (calls) => {
      const url = new URL(`${origin}/login`);
      url.searchParams.set("handle", "alice.example");
      url.searchParams.set("redirect", redirect);
      url.searchParams.set("prompt", "create");
      url.searchParams.set("pwa", "true");
      const res = await handler(new Request(url));
      assertEquals(res.status, 302);
      assertEquals(
        res.headers.get("location"),
        "https://auth.example/authorize?fixture=true",
      );
      assertEquals(await res.text(), "");
      assertSecurity(res);
      assertEquals(calls.authorize.length, 1);
      const { handle, options } = calls.authorize[0];
      assertEquals(handle, "alice.example");
      assertEquals(options.prompt, "create");
      const state = JSON.parse(options.state);
      assertEquals(state.handle, "alice.example");
      assertEquals(state.pwa, true);
      assertEquals(
        state.redirectPath,
        redirect.startsWith("/") && !redirect.startsWith("//")
          ? redirect
          : undefined,
      );
      assert(typeof state.timestamp === "number");
    });
  });
}

Deno.test("migration login accepts auth-server URL/mobile flag and returns authorize errors", async () => {
  await withOAuthBoundary(async (calls) => {
    const res = await handler(
      new Request(
        `${origin}/login?handle=https%3A%2F%2Fauth.example&mobile=true`,
      ),
    );
    assertEquals(res.status, 302);
    assertEquals(JSON.parse(calls.authorize[0].options.state).mobile, true);
  });
  await withOAuthBoundary(async () => {
    const res = await handler(
      new Request(`${origin}/login?handle=alice.example`),
    );
    assertEquals(res.status, 400);
    assertEquals(await res.text(), "fixture authorization failure");
    assertSecurity(res);
  }, { authorize: new Error("fixture authorization failure") });
});

for (
  const [query, body] of [
    ["", "Missing code or state parameters"],
    ["?code=fixture", "Missing code or state parameters"],
    ["?state=%7B%7D", "Missing code or state parameters"],
    ["?code=fixture&state=bad-json", "Invalid state parameter"],
  ]
) {
  Deno.test(`migration callback malformed parameters ${query}`, async () => {
    await withOAuthBoundary(async (calls) => {
      const res = await handler(
        new Request(`${origin}/oauth/callback${query}`),
      );
      assertEquals(res.status, 400);
      assertEquals(await res.text(), body);
      assertEquals(res.headers.get("set-cookie"), null);
      assertSecurity(res);
      assertEquals(calls.callback, []);
    });
  });
}

for (const redirectPath of [undefined, "/save?url=https%3A%2F%2Fexample.com"]) {
  Deno.test(`migration callback persists SQLite session, real encrypted cookie and ${redirectPath ?? "home"} redirect`, async () => {
    await withOAuthBoundary(async (calls) => {
      const before = Date.now();
      const res = await handler(
        new Request(callbackUrl({ handle: "alice.example", redirectPath })),
      );
      assertEquals(res.status, 302);
      assertEquals(res.headers.get("location"), redirectPath ?? "/");
      assertEquals(await res.text(), "");
      assertSecurity(res);
      await assertEncryptedCookie(res.headers.get("set-cookie"));
      const stored = await sessionRow();
      assertEquals(stored.rows.length, 1);
      assertEquals(
        JSON.parse(String(stored.rows[0][0])),
        fixtureSession.toJSON(),
      );
      const expiry = Number(stored.rows[0][1]); // Storage keeps epoch-ms TEXT.
      assert(
        expiry >= before + 1209600_000 - 1000 &&
          expiry <= Date.now() + 1209600_000 + 1000,
      );
      assertEquals(calls.callback.length, 1);
    });
  });
}

Deno.test("migration PWA callback emits completion HTML and real encrypted cookie", async () => {
  await withOAuthBoundary(async () => {
    const res = await handler(
      new Request(callbackUrl({ handle: "alice.example", pwa: true })),
    );
    assertEquals(res.status, 200);
    assertEquals(res.headers.get("content-type"), "text/html; charset=utf-8");
    assertEquals(res.headers.get("location"), null);
    assertSecurity(res);
    await assertEncryptedCookie(res.headers.get("set-cookie"));
    const html = await res.text();
    assertStringIncludes(html, "localStorage.setItem('pwa-oauth-result'");
    assertStringIncludes(html, `did: "${fixtureDid}"`);
    assertStringIncludes(html, 'handle: "alice.example"');
  });
});

Deno.test("migration callback upstream failure is 400 without cookie or new session write", async () => {
  await db.execute({
    sql: "DELETE FROM iron_session_storage WHERE key = ?",
    args: [`session:${fixtureDid}`],
  });
  await withOAuthBoundary(async () => {
    const res = await handler(
      new Request(callbackUrl({ handle: "alice.example" })),
    );
    assertEquals(res.status, 400);
    assertEquals(
      await res.text(),
      "OAuth callback failed: fixture code rejected",
    );
    assertEquals(res.headers.get("set-cookie"), null);
    assertSecurity(res);
    assertEquals((await sessionRow()).rows.length, 0);
  }, { callback: new Error("fixture code rejected") });
});

Deno.test("migration cookie callback → authenticated session refresh → logout storage deletion", async () => {
  await withOAuthBoundary(async (calls) => {
    const callback = await handler(
      new Request(callbackUrl({ handle: "alice.example" })),
    );
    const cookie = await assertEncryptedCookie(
      callback.headers.get("set-cookie"),
    );
    const res = await handler(
      new Request(`${origin}/api/auth/session`, { headers: { cookie } }),
    );
    assertEquals(res.status, 200);
    assertEquals(await res.json(), {
      did: fixtureDid,
      handle: "alice.example",
    });
    assertSecurity(res);
    const refreshed = await assertEncryptedCookie(
      res.headers.get("set-cookie"),
    );
    assert(
      refreshed !== cookie,
      "Refreshed encrypted cookie uses new seal randomness",
    );
    assertEquals(calls.restore, [fixtureDid]);
    // Ledger write is deliberately fire-and-forget; SQLite execute is ordered.
    const ledger = await db.execute({
      sql: "SELECT did FROM seen_dids WHERE did = ?",
      args: [fixtureDid],
    });
    assertEquals(ledger.rows, [[fixtureDid]]);
    const logout = await handler(
      new Request(`${origin}/api/auth/logout`, {
        method: "POST",
        headers: { cookie: refreshed },
      }),
    );
    assertEquals(logout.status, 200);
    assertEquals(await logout.json(), { success: true });
    assertEquals(
      logout.headers.get("set-cookie"),
      "sid=; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=0",
    );
    assertSecurity(logout);
    assertEquals((await sessionRow()).rows.length, 0);
  });
});

for (const cookie of [undefined, "sid=bad-cookie", "sid=%invalid", "sid="]) {
  Deno.test(`migration session rejects missing/corrupt encrypted cookie ${cookie ?? "missing"}`, async () => {
    await withOAuthBoundary(async (calls) => {
      const res = await handler(
        new Request(`${origin}/api/auth/session`, {
          headers: cookie ? { cookie } : {},
        }),
      );
      assertEquals(res.status, 401);
      assertEquals(res.headers.get("set-cookie"), null);
      assertSecurity(res);
      assert(typeof (await res.json()).error === "string");
      assertEquals(calls.restore, []);
      const logout = await handler(
        new Request(`${origin}/api/auth/logout`, {
          method: "POST",
          headers: cookie ? { cookie } : {},
        }),
      );
      assertEquals(logout.status, 200);
      assertEquals(await logout.json(), { success: true });
      assertEquals(
        logout.headers.get("set-cookie"),
        "sid=; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=0",
      );
    });
  });
}

Deno.test("migration session with valid cookie but missing OAuth storage is 401 and drops refresh header", async () => {
  const cookie = (await cookieManager().createSession({
    did: fixtureDid,
    createdAt: Date.now(),
    lastAccessed: Date.now(),
  })).split(";")[0];
  await withOAuthBoundary(async (calls) => {
    const res = await handler(
      new Request(`${origin}/api/auth/session`, { headers: { cookie } }),
    );
    assertEquals(res.status, 401);
    assertEquals(await res.json(), {
      error: "OAuth session not found in storage",
    });
    assertEquals(res.headers.get("set-cookie"), null);
    assertEquals(calls.restore, [fixtureDid]);
    assertSecurity(res);
  }, { missing: true });
});

Deno.test("migration callback issuer mismatch reauthorizes resolved handle without cookie", async () => {
  const mismatch = new IssuerMismatchError(
    "https://expected.example",
    "https://wrong.example",
  );
  mismatch.handle = "alice.example";
  await withOAuthBoundary(async () => {
    const res = await handler(
      new Request(callbackUrl({ handle: "alice.example" })),
    );
    assertEquals(res.status, 302);
    assertEquals(res.headers.get("location"), "/login?handle=alice.example");
    assertEquals(res.headers.get("set-cookie"), null);
    assertSecurity(res);
  }, { callback: mismatch });
});
