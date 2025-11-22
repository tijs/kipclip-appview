/**
 * Session utilities with comprehensive error logging.
 * Wraps OAuth session methods to provide detailed diagnostics.
 */

import type { SessionInterface } from "jsr:@tijs/hono-oauth-sessions@2.1.1";
import { oauth } from "../oauth-config.ts";

export interface SessionResult {
  session: SessionInterface | null;
  error?: {
    type: string;
    message: string;
    details?: unknown;
  };
}

/**
 * Get OAuth session from request with detailed error logging.
 * This replaces direct calls to oauth.sessions.getOAuthSessionFromRequest().
 */
export async function getSessionFromRequest(
  request: Request,
): Promise<SessionResult> {
  try {
    const session = await oauth.sessions.getOAuthSessionFromRequest(request);

    if (!session) {
      console.warn("[Session] No session found in request", {
        url: request.url,
        hasCookie: request.headers.get("cookie")?.includes("sid="),
        timestamp: new Date().toISOString(),
      });

      return {
        session: null,
        error: {
          type: "NO_SESSION",
          message: "No active session found",
        },
      };
    }

    // Session found successfully
    console.debug("[Session] Valid session retrieved", {
      did: session.did,
      url: request.url,
      timestamp: new Date().toISOString(),
    });

    return { session };
  } catch (error) {
    // Detailed error logging for different failure types
    const errorType = error instanceof Error
      ? error.constructor.name
      : "Unknown";
    const errorMessage = error instanceof Error ? error.message : String(error);

    console.error("[Session] Failed to get session from request", {
      errorType,
      errorMessage,
      url: request.url,
      hasCookie: request.headers.get("cookie")?.includes("sid="),
      cookieValue:
        request.headers.get("cookie")?.match(/sid=([^;]+)/)?.[1]?.substring(
          0,
          20,
        ) + "...",
      timestamp: new Date().toISOString(),
      stack: error instanceof Error ? error.stack : undefined,
    });

    // Check for specific error patterns
    if (errorMessage.includes("Invalid handle")) {
      return {
        session: null,
        error: {
          type: "INVALID_HANDLE",
          message: "The handle in the session is invalid or cannot be resolved",
          details: { errorMessage },
        },
      };
    }

    if (errorMessage.includes("expired") || errorMessage.includes("Expired")) {
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

    // Generic error fallback
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
  return oauth.sessions.getClearCookieHeader();
}
