/**
 * Shared utilities for route handlers.
 */

import { getClearSessionCookie, getSessionFromRequest } from "./session.ts";

/** AT Protocol collection names */
export const BOOKMARK_COLLECTION = "community.lexicon.bookmarks.bookmark";
export const TAG_COLLECTION = "com.kipclip.tag";

/** OAuth scopes - granular permissions for only the collections kipclip uses */
export const OAUTH_SCOPES =
  "atproto " +
  "repo:community.lexicon.bookmarks.bookmark?action=create " +
  "repo:community.lexicon.bookmarks.bookmark?action=read " +
  "repo:community.lexicon.bookmarks.bookmark?action=update " +
  "repo:community.lexicon.bookmarks.bookmark?action=delete " +
  "repo:com.kipclip.tag?action=create " +
  "repo:com.kipclip.tag?action=read " +
  "repo:com.kipclip.tag?action=update " +
  "repo:com.kipclip.tag?action=delete";

/**
 * Set the session cookie header on a response if provided.
 */
export function setSessionCookie(
  response: Response,
  setCookieHeader: string | undefined,
): Response {
  if (setCookieHeader) {
    response.headers.set("Set-Cookie", setCookieHeader);
  }
  return response;
}

/**
 * Create a 401 response for unauthenticated requests.
 */
export function createAuthErrorResponse(error?: {
  message?: string;
  type?: string;
}): Response {
  const response = Response.json(
    {
      error: "Authentication required",
      message: error?.message || "Please log in again",
      code: error?.type || "SESSION_EXPIRED",
    },
    { status: 401 },
  );
  response.headers.set("Set-Cookie", getClearSessionCookie());
  return response;
}

/**
 * Helper to get session and return auth error if not authenticated.
 * Returns null if not authenticated (response already sent).
 */
export async function requireAuth(request: Request): Promise<
  {
    session: Awaited<ReturnType<typeof getSessionFromRequest>>["session"];
    setCookieHeader: string | undefined;
  } | null
> {
  const result = await getSessionFromRequest(request);
  if (!result.session) {
    return null;
  }
  return {
    session: result.session,
    setCookieHeader: result.setCookieHeader,
  };
}

/** Re-export for convenience */
export { getClearSessionCookie, getSessionFromRequest };
