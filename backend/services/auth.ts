import { oauth } from "./oauth.ts";

export class AuthInvalidError extends Error {
  constructor(message?: string) {
    super(message || "Authentication invalid");
    this.name = "AuthInvalidError";
  }
}

// Returns a Set-Cookie header string that clears the iron session cookie used
// by the OAuth package. We use conservative defaults (HttpOnly, Path=/, Max-Age=0)
export function clearSidCookieHeader(): string {
  // Note: mirror attributes used by the OAuth package as closely as possible
  return [
    `sid=;`,
    `Path=/;`,
    `HttpOnly;`,
    `SameSite=Lax;`,
    `Max-Age=0;`,
    `Expires=Thu, 01 Jan 1970 00:00:00 GMT;`,
    // If running over HTTPS (recommended) the Secure flag should be set.
    `Secure`,
  ].join(" ");
}

/**
 * Get authenticated OAuth session for a request and return a session-like
 * object where `makeRequest` is wrapped to automatically attempt a refresh
 * when a PDS request fails due to an expired/invalid atproto session.
 *
 * Throws AuthInvalidError when the session cannot be refreshed and should be
 * removed from the user's iron session cookie.
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
  let oauthSession = await oauth.sessions.getOAuthSession(userDid);

  if (!oauthSession) {
    console.error("No OAuth session found for DID:", userDid);
    throw new Error("OAuth session not found");
  }

  // Wrap makeRequest to attempt refresh on auth-related failures.
  async function makeRequest(
    method: string,
    url: string,
    options?: any,
  ): Promise<Response> {
    // Helper to execute request
    const doRequest = async (sess: any) => {
      return sess.makeRequest(method, url, options);
    };

    // First attempt
    let resp = await doRequest(oauthSession);

    // If response indicates an authorization problem, try to refresh once.
    if (
      resp.status === 401 ||
      resp.status === 403 ||
      // Some PDS return 500 when session is invalid/expired — treat as refreshable
      resp.status === 500
    ) {
      // Try to read body for debugging/logging (non-blocking)
      let bodyText = "";
      try {
        bodyText = await resp.text();
      } catch (_e) {
        // ignore
      }
      console.warn(
        `PDS request returned ${resp.status}, attempting to refresh atproto session for ${userDid}: ${bodyText}`,
      );

      // Attempt refresh using the sessions manager. We assume the sessions
      // manager exposes a refresh method; if not available, fall back to
      // deleting the session and signaling invalid auth.
      try {
        // Best-effort: call known refresh method names if present
        if (typeof oauth.sessions.refreshOAuthSession === "function") {
          oauthSession = await oauth.sessions.refreshOAuthSession(userDid);
        } else if (typeof oauth.sessions.refresh === "function") {
          oauthSession = await oauth.sessions.refresh(userDid);
        } else {
          // No refresh API available
          throw new Error("No refresh API available");
        }
      } catch (refreshErr) {
        console.error("Failed to refresh atproto session:", refreshErr);
        // Signal to caller that the iron session must be invalidated
        throw new AuthInvalidError("Failed to refresh atproto session");
      }

      if (!oauthSession) {
        console.error("Refresh returned no session for DID:", userDid);
        throw new AuthInvalidError("Failed to refresh atproto session");
      }

      // Retry request with refreshed session
      resp = await doRequest(oauthSession);
    }

    return resp;
  }

  // Return session object but override makeRequest
  return {
    ...oauthSession,
    makeRequest,
  } as any;
}
