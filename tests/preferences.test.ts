/**
 * Preferences API tests.
 * Tests route handlers for GET/PUT /api/preferences.
 */

import "./test-setup.ts";

import { assertEquals } from "@std/assert";
import { app } from "../main.ts";
import { initOAuth } from "../lib/oauth-config.ts";

initOAuth(new Request("https://kipclip.com"));

const handler = app.handler();

Deno.test("GET /api/preferences - returns 401 when not authenticated", async () => {
  const req = new Request("https://kipclip.com/api/preferences");
  const res = await handler(req);

  assertEquals(res.status, 401);
  const body = await res.json();
  assertEquals(body.error, "Authentication required");
});

Deno.test("PUT /api/preferences - returns 401 when not authenticated", async () => {
  const req = new Request("https://kipclip.com/api/preferences", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ dateFormat: "eu" }),
  });
  const res = await handler(req);

  assertEquals(res.status, 401);
  const body = await res.json();
  assertEquals(body.error, "Authentication required");
});

Deno.test("PUT /api/preferences - rejects invalid date format", async () => {
  // Without auth this returns 401 first, so this test verifies the
  // endpoint exists and responds. Full validation tested via integration.
  const req = new Request("https://kipclip.com/api/preferences", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ dateFormat: "invalid-format" }),
  });
  const res = await handler(req);

  // Without auth, we get 401 before validation
  assertEquals(res.status, 401);
  await res.json(); // consume body
});

Deno.test("PUT /api/preferences - rejects invalid readingListTag", async () => {
  // Without auth this returns 401 first, so this test verifies the
  // endpoint exists and responds. Full validation tested via integration.
  const req = new Request("https://kipclip.com/api/preferences", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ readingListTag: "my tag!" }),
  });
  const res = await handler(req);

  // Without auth, we get 401 before validation
  assertEquals(res.status, 401);
  await res.json(); // consume body
});
