/**
 * Tests for settings API endpoints.
 * Uses mock session to test settings CRUD operations.
 */

import "./test-setup.ts";

import { assertEquals, assertExists } from "@std/assert";
import { app } from "../main.ts";
import { initOAuth } from "../lib/oauth-config.ts";
import { setTestSessionProvider } from "../lib/session.ts";
import { createMockSessionResult } from "./test-helpers.ts";

// Initialize OAuth with test URL
initOAuth(new Request("https://kipclip.com"));
const handler = app.handler();

Deno.test("GET /api/settings - returns 401 when not authenticated", async () => {
  const req = new Request("https://kipclip.com/api/settings");
  const res = await handler(req);

  assertEquals(res.status, 401);
  const body = await res.json();
  assertEquals(body.error, "Authentication required");
});

Deno.test("PATCH /api/settings - returns 401 when not authenticated", async () => {
  const req = new Request("https://kipclip.com/api/settings", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ readingListTag: "readlater" }),
  });
  const res = await handler(req);

  assertEquals(res.status, 401);
  const body = await res.json();
  assertEquals(body.error, "Authentication required");
});

Deno.test({
  name: "GET /api/settings - returns default settings for new user",
  async fn() {
    setTestSessionProvider(() =>
      Promise.resolve(createMockSessionResult({ pdsResponses: new Map() }))
    );

    const req = new Request("https://kipclip.com/api/settings");
    const res = await handler(req);

    assertEquals(res.status, 200);
    const body = await res.json();
    assertExists(body.settings);
    assertEquals(body.settings.readingListTag, "toread");
  },
});

Deno.test({
  name: "PATCH /api/settings - validates tag format",
  async fn() {
    setTestSessionProvider(() =>
      Promise.resolve(createMockSessionResult({ pdsResponses: new Map() }))
    );

    // Test empty tag
    const req = new Request("https://kipclip.com/api/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ readingListTag: "" }),
    });
    const res = await handler(req);

    assertEquals(res.status, 400);
    const body = await res.json();
    assertEquals(body.success, false);
    assertExists(body.error);
  },
});

Deno.test({
  name: "PATCH /api/settings - validates tag characters",
  async fn() {
    setTestSessionProvider(() =>
      Promise.resolve(createMockSessionResult({ pdsResponses: new Map() }))
    );

    // Test tag with invalid characters
    const req = new Request("https://kipclip.com/api/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ readingListTag: "my tag!" }),
    });
    const res = await handler(req);

    assertEquals(res.status, 400);
    const body = await res.json();
    assertEquals(body.success, false);
    assertExists(body.error);
  },
});

Deno.test({
  name: "PATCH /api/settings - accepts Instapaper settings",
  async fn() {
    // Mock successful credential validation
    const originalFetch = globalThis.fetch;
    globalThis.fetch = () => Promise.resolve(new Response("", { status: 200 }));

    try {
      setTestSessionProvider(() =>
        Promise.resolve(createMockSessionResult({ pdsResponses: new Map() }))
      );

      const req = new Request("https://kipclip.com/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          instapaperEnabled: true,
          instapaperUsername: "test@example.com",
          instapaperPassword: "testpassword",
        }),
      });
      const res = await handler(req);

      assertEquals(res.status, 200);
      const body = await res.json();
      assertEquals(body.success, true);
      assertEquals(body.settings.instapaperEnabled, true);
      assertEquals(body.settings.instapaperUsername, "test@example.com");
      // Password should never be returned
      assertEquals(body.settings.instapaperPassword, undefined);
    } finally {
      globalThis.fetch = originalFetch;
    }
  },
});

Deno.test({
  name: "PATCH /api/settings - validates Instapaper credentials",
  async fn() {
    // Mock failed credential validation
    const originalFetch = globalThis.fetch;
    globalThis.fetch = () => Promise.resolve(new Response("", { status: 403 }));

    try {
      setTestSessionProvider(() =>
        Promise.resolve(createMockSessionResult({ pdsResponses: new Map() }))
      );

      const req = new Request("https://kipclip.com/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          instapaperEnabled: true,
          instapaperUsername: "wrong@example.com",
          instapaperPassword: "wrongpass",
        }),
      });
      const res = await handler(req);

      assertEquals(res.status, 400);
      const body = await res.json();
      assertEquals(body.success, false);
      assertExists(body.error);
    } finally {
      globalThis.fetch = originalFetch;
    }
  },
});
