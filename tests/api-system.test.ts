/**
 * Tests for /api/version and /api/health.
 *
 * Both endpoints are unauthenticated GETs that read release metadata
 * from static/manifest.json once at module load. The tests exercise
 * happy-path field shape; the malformed-manifest fallback is covered
 * by the FALLBACK constant in routes/api/system.ts.
 */

import "./test-setup.ts";

import { assertEquals, assertExists } from "@std/assert";
import { app } from "../main.ts";
import { initOAuth } from "../lib/oauth-config.ts";

initOAuth(new Request("https://kipclip.com"));
const handler = app.handler();

Deno.test("GET /api/version returns version, sha, builtAt fields", async () => {
  const req = new Request("https://kipclip.com/api/version");
  const res = await handler(req);
  assertEquals(res.status, 200);
  const body = await res.json();
  assertExists(body.version);
  assertExists(body.sha);
  assertExists(body.builtAt);
  assertEquals(typeof body.version, "string");
  assertEquals(typeof body.sha, "string");
  assertEquals(typeof body.builtAt, "string");
});

Deno.test("GET /api/health returns ok + version", async () => {
  const req = new Request("https://kipclip.com/api/health");
  const res = await handler(req);
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.ok, true);
  assertExists(body.version);
  assertEquals(typeof body.version, "string");
});

Deno.test("GET /api/version is unauthenticated (no session required)", async () => {
  // No session cookie, no auth header. Should still 200.
  const req = new Request("https://kipclip.com/api/version");
  const res = await handler(req);
  assertEquals(res.status, 200);
});
