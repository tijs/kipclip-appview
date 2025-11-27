/**
 * Session utilities with comprehensive error logging and email alerting.
 * Uses @tijs/atproto-oauth for OAuth and session management.
 */

import type { SessionInterface } from "jsr:@tijs/atproto-oauth@0.1.0";
import { SessionManager } from "jsr:@tijs/atproto-sessions@0.1.1";
import { email } from "https://esm.town/v/std/email";
import { oauth } from "../oauth-config.ts";

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

// Rate limit email alerts to avoid spam (max 1 per hour per error type)
const emailRateLimits = new Map<string, number>();
const EMAIL_RATE_LIMIT_MS = 60 * 60 * 1000; // 1 hour

/**
 * Send email alert for unexpected session errors.
 * Rate-limited to prevent spam.
 */
async function sendSessionErrorAlert(
  errorType: string,
  errorMessage: string,
  context: Record<string, unknown>,
): Promise<void> {
  const rateKey = `session_error:${errorType}`;
  const lastSent = emailRateLimits.get(rateKey) || 0;
  const now = Date.now();

  if (now - lastSent < EMAIL_RATE_LIMIT_MS) {
    console.log(
      `[Session] Skipping email alert (rate limited): ${errorType}`,
    );
    return;
  }

  try {
    emailRateLimits.set(rateKey, now);

    await email({
      subject: `[KipClip] Session Error: ${errorType}`,
      text: `
Session Error Alert
===================
Time: ${new Date().toISOString()}
Type: ${errorType}
Message: ${errorMessage}

Context:
${JSON.stringify(context, null, 2)}

This email is rate-limited to once per hour per error type.
      `,
    });

    console.log(`[Session] Sent email alert for: ${errorType}`);
  } catch (emailError) {
    console.error("[Session] Failed to send email alert:", emailError);
  }
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

      // Alert on OAuth errors
      await sendSessionErrorAlert(errorType, errorMessage, {
        did,
        url: request.url,
        details: oauthError,
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

    await sendSessionErrorAlert(errorType, errorMessage, {
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
