import { oauth } from "../index.ts";
import type { Context } from "https://esm.sh/hono";

/**
 * Get authenticated user session from OAuth
 * Extracts session cookie and gets OAuth session from storage
 *
 * @throws Error if not authenticated or session is invalid
 */
export async function getAuthSession(req: Request) {
  // Extract session cookie
  const cookieHeader = req.headers.get("cookie");
  if (!cookieHeader || !cookieHeader.includes("sid=")) {
    throw new Error("Not authenticated");
  }

  const sessionCookie = cookieHeader
    .split(";")
    .find((c) => c.trim().startsWith("sid="))
    ?.split("=")[1];

  if (!sessionCookie) {
    throw new Error("Not authenticated");
  }

  // Unseal session data to get DID - use the COOKIE_SECRET from env
  const { unsealData } = await import("npm:iron-session@8.0.4");
  const COOKIE_SECRET = Deno.env.get("COOKIE_SECRET");

  if (!COOKIE_SECRET) {
    console.error("COOKIE_SECRET environment variable not set");
    throw new Error("Server configuration error");
  }

  const sessionData = await unsealData(decodeURIComponent(sessionCookie), {
    password: COOKIE_SECRET,
  });

  const userDid = (sessionData as any)?.did || (sessionData as any)?.userId ||
    (sessionData as any)?.sub;

  if (!userDid) {
    console.error("No DID found in session data:", sessionData);
    throw new Error("Not authenticated");
  }

  // Get OAuth session using sessions manager
  const oauthSession = await oauth.sessions.getOAuthSession(userDid);

  if (!oauthSession) {
    console.error("No OAuth session found for DID:", userDid);
    throw new Error("OAuth session not found");
  }

  return oauthSession;
}

/**
 * Check if an error is related to authentication/authorization failure
 */
export function isAuthError(error: any): boolean {
  if (!error) return false;

  // Check for auth-related error messages
  const message = error.message?.toLowerCase() || "";
  const authMessages = [
    "not authenticated",
    "oauth session not found",
    "unauthorized",
    "invalid token",
    "expired token",
    "token expired",
    "authentication failed",
    "invalid auth",
  ];

  if (authMessages.some((msg) => message.includes(msg))) {
    return true;
  }

  // Check for HTTP status codes
  if (error.status === 401 || error.status === 403) {
    return true;
  }

  return false;
}

/**
 * Handle authentication errors by cleaning up stale sessions
 * Returns a 401 response with cleared session cookie
 */
export async function handleAuthError(
  c: Context,
  error: any,
  userDid?: string,
) {
  console.error("Authentication error detected:", error.message || error);

  // Try to clean up the OAuth session if we have a DID
  if (userDid) {
    try {
      // Try to delete the OAuth session from storage if the method exists
      if (typeof oauth.sessions.deleteOAuthSession === "function") {
        await oauth.sessions.deleteOAuthSession(userDid);
        console.log(`Deleted stale OAuth session for DID: ${userDid}`);
      } else {
        console.log(
          `OAuth session cleanup skipped (deleteOAuthSession not available) for DID: ${userDid}`,
        );
      }
    } catch (cleanupError) {
      console.error("Failed to cleanup OAuth session:", cleanupError);
    }
  }

  // Clear the session cookie by setting it to expire immediately
  const response = c.json(
    {
      error: "Authentication session expired",
      message: "Please log in again",
      code: "SESSION_EXPIRED",
    },
    401,
  );

  // Clear the session cookie
  response.headers.append(
    "Set-Cookie",
    "sid=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0",
  );

  return response;
}

/**
 * Wrapper for making authenticated requests with automatic error handling
 * Detects authentication failures and triggers session cleanup
 */
export async function makeAuthenticatedRequest(
  c: Context,
  requestFn: () => Promise<any>,
) {
  try {
    return await requestFn();
  } catch (error: any) {
    // Check if this is an authentication-related error
    if (isAuthError(error)) {
      // Try to extract the DID from the request for cleanup
      let userDid: string | undefined;
      try {
        const oauthSession = await getAuthSession(c.req.raw);
        userDid = oauthSession.did;
      } catch {
        // Ignore errors when trying to get DID for cleanup
      }

      return await handleAuthError(c, error, userDid);
    }

    // Re-throw non-auth errors
    throw error;
  }
}
