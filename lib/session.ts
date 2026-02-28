/**
 * Session utilities with comprehensive error logging.
 * Uses @tijs/atproto-oauth for OAuth and session management.
 */

import type { SessionInterface } from "@tijs/atproto-oauth";
import { SessionManager } from "@tijs/atproto-sessions";
import { captureError } from "./sentry.ts";
import { getOAuth } from "./oauth-config.ts";

// Test session provider override (set via setTestSessionProvider)
let testSessionProvider:
  | ((request: Request) => Promise<SessionResult>)
  | null = null;

/**
 * Set a test session provider for testing authenticated routes.
 * Call with null to restore default behavior.
 * @internal Only for use in tests
 */
export function setTestSessionProvider(
  provider: ((request: Request) => Promise<SessionResult>) | null,
): void {
  testSessionProvider = provider;
}

// Session configuration from environment (lazy-loaded)
let sessions: SessionManager | null = null;

function getSessionManager(): SessionManager {
  if (!sessions) {
    const COOKIE_SECRET = Deno.env.get("COOKIE_SECRET");
    if (!COOKIE_SECRET) {
      throw new Error("COOKIE_SECRET environment variable is required");
    }

    // Create session manager for cookie handling (framework-agnostic)
    sessions = new SessionManager({
      cookieSecret: COOKIE_SECRET,
      cookieName: "sid",
      sessionTtl: 60 * 60 * 24 * 14, // 14 days
      logger: console,
    });
  }
  return sessions;
}

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
  // Check for test session provider (testing only)
  if (testSessionProvider) {
    return testSessionProvider(request);
  }

  try {
    // Step 1: Extract session data from cookie using atproto-sessions
    const cookieResult = await getSessionManager().getSessionFromRequest(
      request,
    );

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
    // restore() can throw typed errors for expired/revoked/missing sessions
    const did = cookieResult.data.did;
    let oauthSession: SessionInterface | null;
    try {
      oauthSession = await getOAuth().sessions.getOAuthSession(did);
    } catch (restoreError) {
      // Known session errors — return null session, no Sentry report
      const errorName = restoreError instanceof Error
        ? restoreError.constructor.name
        : "";
      const isRecoverableSessionError = [
        "SessionNotFoundError",
        "SessionError",
        "RefreshTokenExpiredError",
        "RefreshTokenRevokedError",
        "TokenExchangeError",
      ].includes(errorName);

      if (isRecoverableSessionError) {
        console.warn("[Session] OAuth session restore failed (recoverable)", {
          did,
          errorName,
          errorMessage: restoreError instanceof Error
            ? restoreError.message
            : String(restoreError),
          url: request.url,
        });
        return {
          session: null,
          setCookieHeader: cookieResult.setCookieHeader,
          error: {
            type: "SESSION_EXPIRED",
            message: "Your session has expired, please sign in again",
          },
        };
      }

      // Unknown/transient errors (e.g. NetworkError) — re-throw to outer catch
      throw restoreError;
    }

    if (!oauthSession) {
      console.warn("[Session] OAuth session not available", {
        did,
        url: request.url,
      });

      return {
        session: null,
        error: {
          type: "SESSION_EXPIRED",
          message: "Your session has expired, please sign in again",
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
  return getSessionManager().getClearCookieHeader();
}
