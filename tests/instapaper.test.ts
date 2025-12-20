/**
 * Tests for Instapaper API client.
 * Uses mocked fetch to avoid external dependencies.
 */

import { assertEquals } from "@std/assert";
import {
  sendToInstapaper,
  validateInstapaperCredentials,
} from "../lib/instapaper.ts";

// Mock fetch responses
function createMockFetch(
  responses: Map<string, Response>,
): typeof fetch {
  return (
    input: RequestInfo | URL,
    _init?: RequestInit,
  ): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();

    for (const [pattern, response] of responses) {
      if (url.includes(pattern)) {
        return Promise.resolve(response.clone());
      }
    }

    return Promise.resolve(new Response("Not Found", { status: 404 }));
  };
}

Deno.test("sendToInstapaper - success returns true", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = createMockFetch(
    new Map([
      ["instapaper.com/api/add", new Response("", { status: 201 })],
    ]),
  );

  try {
    const result = await sendToInstapaper(
      "https://example.com/article",
      { username: "test@example.com", password: "testpass" },
    );

    assertEquals(result.success, true);
    assertEquals(result.error, undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test(
  "sendToInstapaper - invalid credentials returns error",
  async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = createMockFetch(
      new Map([
        ["instapaper.com/api/add", new Response("", { status: 403 })],
      ]),
    );

    try {
      const result = await sendToInstapaper(
        "https://example.com/article",
        { username: "wrong", password: "wrong" },
      );

      assertEquals(result.success, false);
      assertEquals(result.error, "Invalid Instapaper credentials");
    } finally {
      globalThis.fetch = originalFetch;
    }
  },
);

Deno.test("sendToInstapaper - includes title in request", async () => {
  const originalFetch = globalThis.fetch;
  let capturedUrl = "";

  globalThis.fetch = (input: RequestInfo | URL): Promise<Response> => {
    capturedUrl = input.toString();
    return Promise.resolve(new Response("", { status: 201 }));
  };

  try {
    await sendToInstapaper(
      "https://example.com/article",
      { username: "test", password: "test" },
      "Test Article Title",
    );

    assertEquals(capturedUrl.includes("title=Test+Article+Title"), true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test(
  "validateInstapaperCredentials - valid returns true",
  async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = createMockFetch(
      new Map([
        ["instapaper.com/api/authenticate", new Response("", { status: 200 })],
      ]),
    );

    try {
      const result = await validateInstapaperCredentials({
        username: "test@example.com",
        password: "testpass",
      });

      assertEquals(result.valid, true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  },
);

Deno.test(
  "validateInstapaperCredentials - invalid returns false with error",
  async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = createMockFetch(
      new Map([
        ["instapaper.com/api/authenticate", new Response("", { status: 403 })],
      ]),
    );

    try {
      const result = await validateInstapaperCredentials({
        username: "wrong",
        password: "wrong",
      });

      assertEquals(result.valid, false);
      assertEquals(result.error, "Invalid username or password");
    } finally {
      globalThis.fetch = originalFetch;
    }
  },
);
