import { assertEquals } from "@std/assert";

export function assertIsolated(): void {
  assertEquals(Deno.env.get("KIPCLIP_TESTING"), "1");
  assertEquals(Deno.env.get("DATABASE_URL"), "file::memory:");
  assertEquals(Deno.env.get("SENTRY_DSN") ?? "", "");
}

export const securityHeaders = {
  "x-frame-options": "DENY",
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
  "strict-transport-security": "max-age=31536000; includeSubDomains",
  "permissions-policy": "camera=(), microphone=(), geolocation=()",
};

export function assertSecurity(response: Response): void {
  for (const [key, value] of Object.entries(securityHeaders)) {
    assertEquals(response.headers.get(key), value, key);
  }
}

/** No passthrough: even an unexpected URL can never reach the network. */
export async function withMockFetch<T>(
  reply: (request: Request) => Response | Promise<Response>,
  run: (calls: Request[]) => Promise<T>,
): Promise<T> {
  const original = globalThis.fetch;
  const calls: Request[] = [];
  const unexpected: unknown[] = [];
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    calls.push(request);
    try {
      return await reply(request);
    } catch (error) {
      unexpected.push(error);
      throw error;
    }
  };
  try {
    const result = await run(calls);
    // Routes may swallow fetch failures. Unexpected calls must still fail tests.
    assertEquals(unexpected, [], "Unexpected mocked fetch failure");
    return result;
  } finally {
    globalThis.fetch = original;
  }
}

export function loopbackInfo(hostname = "127.0.0.1"): Deno.ServeHandlerInfo {
  return {
    remoteAddr: { transport: "tcp", hostname, port: 12345 },
    completed: Promise.resolve(),
  } as Deno.ServeHandlerInfo;
}
