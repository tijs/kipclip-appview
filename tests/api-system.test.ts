/**
 * Tests for /api/version and /api/health.
 *
 * Both endpoints are unauthenticated GETs that read release metadata
 * from a manifest file once at module load. test-setup.ts writes a
 * fixture and sets KIPCLIP_MANIFEST_PATH so these tests assert exact
 * values — proving the read + parse + response shape end-to-end. A
 * shape-only assertion (e.g., assertExists) would have passed against
 * the v0.10.1 FALLBACK regression where every field returned "unknown".
 */

import "./test-setup.ts";

import { assertEquals } from "@std/assert";
import { app } from "../main.ts";
import { initOAuth } from "../lib/oauth-config.ts";

initOAuth(new Request("https://kipclip.com"));
const handler = app.handler();

Deno.test("GET /api/version returns fixture manifest values, not FALLBACK", async () => {
  const req = new Request("https://kipclip.com/api/version");
  const res = await handler(req);
  assertEquals(res.status, 200);
  const body = await res.json();
  // Exact fixture values from tests/test-setup.ts. If any of these come
  // back as "unknown", manifest read silently fell back to FALLBACK —
  // which is exactly the v0.10.1 regression this test guards against.
  assertEquals(body.version, "v-test");
  assertEquals(body.sha, "testsha");
  assertEquals(body.builtAt, "2026-05-06T00:00:00.000Z");
});

Deno.test("GET /api/health returns ok + version from manifest", async () => {
  const req = new Request("https://kipclip.com/api/health");
  const res = await handler(req);
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.ok, true);
  assertEquals(body.version, "v-test");
});

Deno.test("GET /api/version is unauthenticated (no session required)", async () => {
  // No session cookie, no auth header. Should still 200.
  const req = new Request("https://kipclip.com/api/version");
  const res = await handler(req);
  assertEquals(res.status, 200);
});

Deno.test("POST /api/csp-report accepts violation report and returns 204", async () => {
  // Browsers POST a CSP violation report when a directive is violated.
  // The endpoint exists ahead of CSP enforcement so the policy can ship
  // with `report-to` pointing here on day one. 204 = no body, browser
  // takes no action, ack-only sink.
  const reportBody = JSON.stringify({
    "csp-report": {
      "document-uri": "https://kipclip.com/",
      "violated-directive": "script-src",
      "blocked-uri": "https://evil.example.com/x.js",
    },
  });
  const req = new Request("https://kipclip.com/api/csp-report", {
    method: "POST",
    headers: { "Content-Type": "application/csp-report" },
    body: reportBody,
  });
  const res = await handler(req);
  assertEquals(res.status, 204);
  // 204 must have empty body — browsers ignore it but spec compliance
  // matters for proxies that strip non-empty 204 responses.
  const text = await res.text();
  assertEquals(text, "");
});

Deno.test("POST /api/csp-report truncates oversized body without erroring", async () => {
  // Hostile or buggy reporters could ship a huge body. Endpoint must
  // truncate at 4KB internally and still return 204.
  const huge = JSON.stringify({ "csp-report": { dump: "x".repeat(10_000) } });
  const req = new Request("https://kipclip.com/api/csp-report", {
    method: "POST",
    headers: { "Content-Type": "application/csp-report" },
    body: huge,
  });
  const res = await handler(req);
  assertEquals(res.status, 204);
});
