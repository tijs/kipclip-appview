/**
 * Unit tests for bookmarks API routes.
 * Uses MemoryStorage and mocked OAuth sessions for fast, isolated testing.
 */

// Load test environment before importing application code
import "../test-setup.ts";

import { assertEquals } from "jsr:@std/assert@1";
import { App } from "jsr:@fresh/core@^2.2.0";
import { registerBookmarksRoutes } from "./bookmarks.ts";

// Create a test app with the bookmarks routes
function createTestApp() {
  let app = new App<any>();
  app = registerBookmarksRoutes(app);
  return app.handler();
}

Deno.test("GET /api/bookmarks - returns 401 when not authenticated", async () => {
  const handler = createTestApp();
  const req = new Request("https://test.val.town/api/bookmarks");
  const res = await handler(req);

  assertEquals(res.status, 401);
  const body = await res.json();
  assertEquals(body.error, "Authentication required");
});

Deno.test("GET /api/bookmarks - requires authentication", async () => {
  const handler = createTestApp();
  // Make request without session cookie
  const req = new Request("https://test.val.town/api/bookmarks", {
    method: "GET",
  });

  const res = await handler(req);

  assertEquals(res.status, 401);
  const data = await res.json();
  // Returns NO_COOKIE when no session cookie is present (more precise error type)
  assertEquals(data.code, "NO_COOKIE");
});

// Note: Full integration tests with real PDS would go in a separate integration test file
// These unit tests focus on the route handler logic and error handling
