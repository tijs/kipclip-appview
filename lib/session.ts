/**
 * Session utilities with comprehensive error logging.
 * Uses @tijs/atproto-oauth for OAuth and session management.
 */

import type { SessionInterface } from "jsr:@tijs/atproto-oauth@2.1.0";
import { SessionManager } from "jsr:@tijs/atproto-sessions@2.1.0";
import { captureError } from "./sentry.ts";
import { oauth } from "./oauth-config.ts";

// Session configuration from environment
const COOKIE_SECRET = Deno.env.get("COOKIE_SECRET");
if (!COOKIE_SECRET) {
  throw new Error("COOKIE_SECRET environment variable is required");
}

// Create session manager for cookie handling (framework-agnostic)
const sessions = new SessionManager({
  cookieSecret: COOKIE_SECRET,
  cookieName: "sid",
  sessionTtl: 60 * 60 * 24 * 14, // 14 days
  logger: console,
});

export interface SessionResult {
  session: SessionInterface | null;
  /** Set-Cookie header to refresh the session - should be set on response */
  setCookieHeader?: string;
  error?: {
    type: string;
    message: string;
    details?: unknown;
  };
}

/**
 * Report session error to Sentry for monitoring.
 */
function reportSessionError(
  errorType: string,
  errorMessage: string,
  context: Record<string, unknown>,
): void {
  const error = new Error(`Session Error: ${errorType} - ${errorMessage}`);
  error.name = errorType;
  captureError(error, {
    errorType,
    errorMessage,
    ...context,
  });
}

/**
 * Get OAuth session from request with detailed error logging and cookie refresh.
 *
 * Uses @tijs/atproto-sessions for cookie extraction and refresh,
 * then gets the OAuth session via hono-oauth-sessions.
 *
 * @param request - The HTTP request
 * @returns SessionResult with session, setCookieHeader, and optional error
 */
export async function getSessionFromRequest(
  request: Request,
): Promise<SessionResult> {
  try {
    // Step 1: Extract session data from cookie using atproto-sessions
    const cookieResult = await sessions.getSessionFromRequest(request);

    if (!cookieResult.data) {
      const errorType = cookieResult.error?.type || "NO_SESSION";
      const errorMessage = cookieResult.error?.message ||
        "No active session found";

      console.warn("[Session] No session cookie found", {
        url: request.url,
        hasCookie: request.headers.get("cookie")?.includes("sid="),
        errorType,
        errorMessage,
        timestamp: new Date().toISOString(),
      });

      return {
        session: null,
        error: {
          type: errorType,
          message: errorMessage,
          details: cookieResult.error?.details,
        },
      };
    }

    // Step 2: Get OAuth session using the DID from cookie
    const did = cookieResult.data.did;
    let oauthSession: SessionInterface | null;

    try {
      oauthSession = await oauth.sessions.getOAuthSession(did);
    } catch (oauthError) {
      const errorType = oauthError instanceof Error
        ? oauthError.constructor.name
        : "OAUTH_ERROR";
      const errorMessage = oauthError instanceof Error
        ? oauthError.message
        : String(oauthError);

      console.error("[Session] Failed to restore OAuth session", {
        did,
        errorType,
        errorMessage,
        url: request.url,
        timestamp: new Date().toISOString(),
      });

      // Report OAuth errors to Sentry
      reportSessionError(errorType, errorMessage, {
        did,
        url: request.url,
      });

      // Map specific error patterns
      if (errorMessage.includes("Invalid handle")) {
        return {
          session: null,
          error: {
            type: "INVALID_HANDLE",
            message:
              "The handle in the session is invalid or cannot be resolved",
            details: { errorMessage },
          },
        };
      }

      if (
        errorMessage.includes("expired") || errorMessage.includes("Expired")
      ) {
        return {
          session: null,
          error: {
            type: "SESSION_EXPIRED",
            message: "Your session has expired",
            details: { errorMessage },
          },
        };
      }

      if (errorMessage.includes("refresh") || errorMessage.includes("token")) {
        return {
          session: null,
          error: {
            type: "TOKEN_ERROR",
            message: "Session token error",
            details: { errorMessage },
          },
        };
      }

      return {
        session: null,
        error: {
          type: errorType,
          message: errorMessage,
          details: oauthError,
        },
      };
    }

    if (!oauthSession) {
      console.warn("[Session] OAuth session not found in storage", {
        did,
        url: request.url,
        timestamp: new Date().toISOString(),
      });

      return {
        session: null,
        error: {
          type: "SESSION_EXPIRED",
          message: "OAuth session not found in storage",
        },
      };
    }

    // Session found successfully
    console.debug("[Session] Valid session retrieved", {
      did: oauthSession.did,
      url: request.url,
      hasRefreshCookie: !!cookieResult.setCookieHeader,
      timestamp: new Date().toISOString(),
    });

    return {
      session: oauthSession,
      setCookieHeader: cookieResult.setCookieHeader,
    };
  } catch (error) {
    // Unexpected error
    const errorType = error instanceof Error
      ? error.constructor.name
      : "Unknown";
    const errorMessage = error instanceof Error ? error.message : String(error);

    console.error("[Session] Unexpected error getting session", {
      errorType,
      errorMessage,
      url: request.url,
      timestamp: new Date().toISOString(),
      stack: error instanceof Error ? error.stack : undefined,
    });

    reportSessionError(errorType, errorMessage, {
      url: request.url,
      stack: error instanceof Error ? error.stack : undefined,
    });

    return {
      session: null,
      error: {
        type: errorType,
        message: errorMessage,
        details: error,
      },
    };
  }
}

/**
 * Get clear cookie header for session cleanup.
 */
export function getClearSessionCookie(): string {
  return sessions.getClearCookieHeader();
}
