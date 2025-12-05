/**
 * API tests for kipclip.
 * Tests route handlers via the app handler function.
 */

// Load test environment before importing application code
import "./test-setup.ts";

import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1";

// Import the app handler
import handler from "../main.ts";

Deno.test("GET /api/bookmarks - returns 401 when not authenticated", async () => {
  const req = new Request("https://kipclip.com/api/bookmarks");
  const res = await handler(req);

  assertEquals(res.status, 401);
  const body = await res.json();
  assertEquals(body.error, "Authentication required");
});

Deno.test("GET /api/bookmarks - requires authentication", async () => {
  // Make request without session cookie
  const req = new Request("https://kipclip.com/api/bookmarks", {
    method: "GET",
  });

  const res = await handler(req);

  assertEquals(res.status, 401);
  const data = await res.json();
  // Returns NO_COOKIE when no session cookie is present
  assertEquals(data.code, "NO_COOKIE");
});

Deno.test("GET /api/tags - returns 401 when not authenticated", async () => {
  const req = new Request("https://kipclip.com/api/tags");
  const res = await handler(req);

  assertEquals(res.status, 401);
  const body = await res.json();
  assertEquals(body.error, "Authentication required");
});

Deno.test("POST /api/bookmarks - returns 401 when not authenticated", async () => {
  const req = new Request("https://kipclip.com/api/bookmarks", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url: "https://example.com" }),
  });

  const res = await handler(req);

  assertEquals(res.status, 401);
  const body = await res.json();
  assertEquals(body.error, "Authentication required");
});

Deno.test("GET /robots.txt - returns robots.txt content", async () => {
  const req = new Request("https://kipclip.com/robots.txt");
  const res = await handler(req);

  assertEquals(res.status, 200);
  assertEquals(res.headers.get("Content-Type"), "text/plain");

  const body = await res.text();
  assertStringIncludes(body, "User-agent: *");
  assertStringIncludes(body, "Disallow: /api/");
  assertStringIncludes(body, "Sitemap: https://kipclip.com/sitemap.xml");
});

Deno.test("GET /oauth-client-metadata.json - returns OAuth metadata", async () => {
  const req = new Request("https://kipclip.com/oauth-client-metadata.json");
  const res = await handler(req);

  assertEquals(res.status, 200);
  assertEquals(res.headers.get("Content-Type"), "application/json");

  const body = await res.json();
  assertEquals(body.client_name, "kipclip");
  assertEquals(
    body.client_id,
    "https://kipclip.com/oauth-client-metadata.json",
  );
  assertEquals(body.dpop_bound_access_tokens, true);
});

Deno.test("RSS feed - RFC 822 date format", () => {
  // Test date formatting
  const testDate = "2025-11-01T12:00:00.000Z";
  const date = new Date(testDate);
  const rfc822 = date.toUTCString();

  // Should match RFC 822 format: "Fri, 01 Nov 2025 12:00:00 GMT"
  assertStringIncludes(rfc822, "Nov 2025");
  assertStringIncludes(rfc822, "GMT");
});

// Note: Full integration tests with real PDS would go in a separate integration test file
// These unit tests focus on the route handler logic and error handling
