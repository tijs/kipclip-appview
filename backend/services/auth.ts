import { oauth } from "../index.ts";
import type { Context } from "https://esm.sh/hono";

/**
 * Get authenticated user session from OAuth with automatic token refresh.
 *
 * This function extracts the user's DID from the iron session cookie and retrieves
 * the OAuth session from storage. The underlying oauth.sessions.getOAuthSession()
 * automatically refreshes expired tokens, so this function either returns a valid
 * session or null if the session cannot be restored (e.g., refresh failed, session
 * doesn't exist, or tokens were revoked).
 *
 * @param req - The HTTP request containing the session cookie
 * @returns OAuth session with valid tokens, or null if session is invalid/expired
 *
 * @example Usage in route handlers
 * ```typescript
 * const oauthSession = await getAuthSession(c.req.raw);
 * if (!oauthSession) {
 *   return c.json({ error: "Authentication required" }, 401, {
 *     headers: { "Set-Cookie": clearSessionCookie() }
 *   });
 * }
 * ```
 */
export async function getAuthSession(
  req: Request,
): Promise<any | null> {
  try {
    // Extract session cookie
    const cookieHeader = req.headers.get("cookie");
    if (!cookieHeader || !cookieHeader.includes("sid=")) {
      return null;
    }

    const sessionCookie = cookieHeader
      .split(";")
      .find((c) => c.trim().startsWith("sid="))
      ?.split("=")[1];

    if (!sessionCookie) {
      return null;
    }

    // Unseal session data to get DID - use the COOKIE_SECRET from env
    const { unsealData } = await import("npm:iron-session@8.0.4");
    const COOKIE_SECRET = Deno.env.get("COOKIE_SECRET");

    if (!COOKIE_SECRET) {
      console.error("COOKIE_SECRET environment variable not set");
      return null;
    }

    const sessionData = await unsealData(decodeURIComponent(sessionCookie), {
      password: COOKIE_SECRET,
    });

    const userDid = (sessionData as any)?.did || (sessionData as any)?.userId ||
      (sessionData as any)?.sub;

    if (!userDid) {
      console.error("No DID found in session data:", sessionData);
      return null;
    }

    // Get OAuth session using sessions manager
    // This automatically refreshes expired tokens via the underlying oauth-client-deno
    // restore() method which checks session.isExpired and calls refresh() if needed
    const oauthSession = await oauth.sessions.getOAuthSession(userDid);

    if (!oauthSession) {
      console.log(
        `OAuth session not found or refresh failed for DID: ${userDid}`,
      );
      return null;
    }

    return oauthSession;
  } catch (error) {
    console.error("Failed to get authenticated session:", error);
    return null;
  }
}

/**
 * Returns a Set-Cookie header that clears the iron session cookie.
 *
 * Use this when the OAuth session is invalid/expired to ensure the user
 * is fully logged out and will be prompted to re-authenticate.
 *
 * @returns Set-Cookie header string to clear the sid cookie
 */
export function clearSessionCookie(): string {
  return "sid=; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=0";
}

/**
 * Helper to return a consistent 401 response with cleared session cookie.
 *
 * Use this when getAuthSession() returns null to ensure the iron session
 * cookie is cleared and the user knows they need to re-authenticate.
 *
 * @param c - Hono context
 * @returns 401 Response with cleared cookie
 */
export function unauthorizedResponse(c: Context): Response {
  const response = c.json(
    {
      error: "Authentication required",
      message: "Please log in again",
      code: "SESSION_EXPIRED",
    },
    401,
  );
  response.headers.set("Set-Cookie", clearSessionCookie());
  return response;
}
