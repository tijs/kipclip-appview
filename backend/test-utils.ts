/**
 * Test utilities for kipclip unit tests.
 * Provides helpers for creating test OAuth instances and mock sessions.
 */

import {
  createATProtoOAuth,
  MemoryStorage,
} from "jsr:@tijs/atproto-oauth-hono@2.0.11";
import type { ATProtoOAuthInstance } from "jsr:@tijs/atproto-oauth-hono@2.0.11";
import type { SessionInterface } from "jsr:@tijs/hono-oauth-sessions@2.1.1";

/**
 * Creates a test OAuth instance with MemoryStorage.
 * Perfect for unit tests - fast, isolated, no database needed.
 *
 * @returns OAuth instance configured for testing
 *
 * @example
 * ```typescript
 * const oauth = createTestOAuth();
 * const session = createMockSession();
 * await oauth.sessions.saveOAuthSession(session);
 * ```
 */
export function createTestOAuth(): ATProtoOAuthInstance {
  return createATProtoOAuth({
    baseUrl: "https://test.val.town",
    appName: "Test App",
    cookieSecret: "test-secret-minimum-32-chars-long!!",
    storage: new MemoryStorage(),
    sessionTtl: 60 * 60, // 1 hour for tests
  });
}

/**
 * Creates a mock OAuth session for testing.
 * Use this to bypass real authentication in unit tests.
 *
 * @param overrides - Optional partial session data to override defaults
 * @returns Mock session interface
 *
 * @example
 * ```typescript
 * // Create session with default test user
 * const session = createMockSession();
 *
 * // Create session for specific user
 * const session = createMockSession({
 *   sub: "did:plc:customuser123",
 *   handle: "custom.test",
 * });
 * ```
 */
export function createMockSession(
  overrides?: Partial<SessionInterface>,
): SessionInterface {
  const now = Math.floor(Date.now() / 1000);
  const defaultSession: SessionInterface = {
    sub: "did:plc:test123",
    handle: "test.bsky.social",
    accessToken: "mock-access-token",
    refreshToken: "mock-refresh-token",
    tokenType: "DPoP",
    scope: "atproto",
    expiresAt: now + 3600, // 1 hour from now
    dpopKey: {
      kty: "EC",
      crv: "P-256",
      x: "mock-x-value",
      y: "mock-y-value",
      d: "mock-d-value",
    },
    serverMetadata: {
      issuer: "https://bsky.social",
      authorization_endpoint: "https://bsky.social/oauth/authorize",
      token_endpoint: "https://bsky.social/oauth/token",
      pushed_authorization_request_endpoint: "https://bsky.social/oauth/par",
      dpop_signing_alg_values_supported: ["ES256"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      response_types_supported: ["code"],
      scopes_supported: ["atproto"],
      token_endpoint_auth_methods_supported: ["none"],
      authorization_response_iss_parameter_supported: true,
      require_pushed_authorization_requests: true,
    },
  };

  return { ...defaultSession, ...overrides };
}

/**
 * Creates a mock Request object for testing route handlers.
 *
 * @param options - Request options
 * @returns Mock Request instance
 *
 * @example
 * ```typescript
 * const req = createMockRequest({
 *   url: "https://test.val.town/api/bookmarks",
 *   method: "GET",
 *   headers: { "cookie": "sid=test-session" },
 * });
 * ```
 */
export function createMockRequest(options: {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}): Request {
  const { url, method = "GET", headers = {}, body } = options;

  return new Request(url, {
    method,
    headers,
    body,
  });
}

/**
 * Waits for a condition to be true within a timeout.
 * Useful for testing async operations with eventual consistency.
 *
 * @param condition - Function that returns true when condition is met
 * @param timeout - Maximum time to wait in milliseconds (default: 1000)
 * @param interval - How often to check in milliseconds (default: 10)
 *
 * @example
 * ```typescript
 * await waitFor(() => sessionStorage.has("user:123"), 1000);
 * ```
 */
export async function waitFor(
  condition: () => boolean | Promise<boolean>,
  timeout = 1000,
  interval = 10,
): Promise<void> {
  const startTime = Date.now();

  while (Date.now() - startTime < timeout) {
    if (await condition()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, interval));
  }

  throw new Error(`Timeout waiting for condition after ${timeout}ms`);
}
