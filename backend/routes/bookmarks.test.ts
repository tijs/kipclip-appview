/**
 * Unit tests for bookmarks API routes.
 * Uses MemoryStorage and mocked OAuth sessions for fast, isolated testing.
 */

import { assertEquals } from "jsr:@std/assert@1";
import { bookmarksApi } from "./bookmarks.ts";

Deno.test("GET /bookmarks - returns 401 when not authenticated", async () => {
  const req = new Request("https://test.val.town/api/bookmarks");
  const res = await bookmarksApi.fetch(req);

  assertEquals(res.status, 401);
  const body = await res.json();
  assertEquals(body.error, "Authentication required");
});

Deno.test("GET /bookmarks - requires authentication", async () => {
  // Make request without session cookie
  const req = new Request("https://test.val.town/api/bookmarks", {
    method: "GET",
  });

  const res = await bookmarksApi.fetch(req);

  assertEquals(res.status, 401);
  const data = await res.json();
  assertEquals(data.code, "SESSION_EXPIRED");
});

// Note: Full integration tests with real PDS would go in a separate integration test file
// These unit tests focus on the route handler logic and error handling
