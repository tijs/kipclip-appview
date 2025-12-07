/**
 * Test helpers for creating mock dependencies.
 * Enables testing without network calls or external services.
 */

import type { SessionInterface } from "@tijs/atproto-oauth";
import type { SessionResult } from "../lib/session.ts";

/**
 * Mock session for testing authenticated routes.
 */
export interface MockSessionOptions {
  did?: string;
  pdsUrl?: string;
  handle?: string;
  /** Mock responses for makeRequest calls, keyed by URL pattern */
  pdsResponses?: Map<string, Response>;
  /** Default response if no pattern matches */
  defaultPdsResponse?: Response;
}

/**
 * Create a mock OAuth session for testing.
 */
export function createMockSession(
  options: MockSessionOptions = {},
): SessionInterface {
  const {
    did = "did:plc:test123",
    pdsUrl = "https://test.pds.example",
    handle = "test.handle",
    pdsResponses = new Map(),
    defaultPdsResponse = new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  } = options;

  return {
    did,
    pdsUrl,
    handle,
    makeRequest: (
      _method: string,
      endpoint: string,
      _options?: { body?: unknown; headers?: Record<string, string> },
    ): Promise<Response> => {
      // Check for matching response
      for (const [pattern, response] of pdsResponses) {
        if (endpoint.includes(pattern)) {
          // Clone response since Response can only be consumed once
          return Promise.resolve(response.clone());
        }
      }
      return Promise.resolve(defaultPdsResponse.clone());
    },
  } as SessionInterface;
}

/**
 * Create a successful session result for testing.
 */
export function createMockSessionResult(
  options: MockSessionOptions = {},
): SessionResult {
  return {
    session: createMockSession(options),
    setCookieHeader: "sid=mock-session-id; Path=/; HttpOnly; SameSite=Lax",
  };
}

/**
 * Create a mock PDS response for common operations.
 */
export function createPdsResponse(
  data: unknown,
  status = 200,
): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Create a mock PDS response for createRecord.
 */
export function createRecordResponse(
  rkey = "test-rkey-123",
  cid = "bafytest123",
): Response {
  return createPdsResponse({
    uri: `at://did:plc:test123/community.lexicon.bookmarks.bookmark/${rkey}`,
    cid,
  });
}

/**
 * Create a mock PDS response for listRecords.
 */
export function listRecordsResponse(
  records: Array<{ uri: string; cid: string; value: unknown }>,
  cursor?: string,
): Response {
  return createPdsResponse({ records, cursor });
}

/**
 * Create a mock fetch function for URL metadata extraction.
 * Returns HTML with the specified metadata.
 */
export function createMockFetcher(
  responses: Map<string, Response | (() => Response)>,
): typeof fetch {
  return (input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string"
      ? input
      : input instanceof URL
      ? input.href
      : input.url;

    for (const [pattern, response] of responses) {
      if (url.includes(pattern)) {
        const res = typeof response === "function"
          ? response()
          : response.clone();
        return Promise.resolve(res);
      }
    }

    // Default: return 404
    return Promise.resolve(new Response("Not Found", { status: 404 }));
  };
}

/**
 * Create a mock HTML response with metadata.
 */
export function createHtmlResponse(
  options: {
    title?: string;
    ogTitle?: string;
    description?: string;
    ogDescription?: string;
    favicon?: string;
  } = {},
): Response {
  const { title, ogTitle, description, ogDescription, favicon } = options;

  const html = `
<!DOCTYPE html>
<html>
<head>
  ${title ? `<title>${title}</title>` : ""}
  ${ogTitle ? `<meta property="og:title" content="${ogTitle}">` : ""}
  ${description ? `<meta name="description" content="${description}">` : ""}
  ${
    ogDescription
      ? `<meta property="og:description" content="${ogDescription}">`
      : ""
  }
  ${favicon ? `<link rel="icon" href="${favicon}">` : ""}
</head>
<body></body>
</html>`;

  return new Response(html, {
    status: 200,
    headers: { "Content-Type": "text/html" },
  });
}

/**
 * Create a mock PLC directory response.
 */
export function createPlcResponse(
  options: {
    did?: string;
    pdsUrl?: string;
    handle?: string;
  } = {},
): Response {
  const {
    did = "did:plc:test123",
    pdsUrl = "https://test.pds.example",
    handle = "test.handle",
  } = options;

  return new Response(
    JSON.stringify({
      id: did,
      alsoKnownAs: [`at://${handle}`],
      service: [
        {
          id: "#atproto_pds",
          type: "AtprotoPersonalDataServer",
          serviceEndpoint: pdsUrl,
        },
      ],
    }),
    {
      status: 200,
      headers: { "Content-Type": "application/json" },
    },
  );
}

// Session override for testing
let mockSessionProvider:
  | ((request: Request) => Promise<SessionResult>)
  | null = null;

/**
 * Set a mock session provider for testing.
 * Call with null to restore default behavior.
 */
export function setMockSessionProvider(
  provider: ((request: Request) => Promise<SessionResult>) | null,
): void {
  mockSessionProvider = provider;
}

/**
 * Get the current mock session provider, if set.
 */
export function getMockSessionProvider():
  | ((request: Request) => Promise<SessionResult>)
  | null {
  return mockSessionProvider;
}
