/**
 * Sentry error tracking for kipclip.
 * Captures errors and sends them to Sentry for monitoring.
 */

import * as Sentry from "@sentry/deno";

const SENTRY_DSN = Deno.env.get("SENTRY_DSN");
const isProduction = Deno.env.get("ENVIRONMENT") !== "DEVELOPMENT";

// Initialize Sentry (only in production or if DSN is explicitly set)
if (SENTRY_DSN) {
  Sentry.init({
    dsn: SENTRY_DSN,
    environment: isProduction ? "production" : "development",
    // Only send errors in production, or all in dev if DSN is set
    enabled: true,
    // Sample rate for performance monitoring (0 = disabled)
    tracesSampleRate: 0,
    beforeSend(event, hint) {
      const error = hint?.originalException;
      // Skip expected HTTP errors (404, 405) — mostly bots/scanners
      if (error instanceof Error && error.name === "HttpError") {
        const msg = error.message;
        if (msg === "Not Found" || msg === "Method Not Allowed") {
          return null;
        }
      }
      // Skip transient DNS resolution failures (Deno Deploy infra issue)
      if (
        error instanceof Error &&
        error.message?.includes("ENOTFOUND")
      ) {
        return null;
      }
      return event;
    },
  });
  console.log("✅ Sentry error tracking initialized");
} else if (isProduction) {
  console.warn("⚠️ SENTRY_DSN not set - error tracking disabled");
}

/**
 * Capture an error and send to Sentry.
 * Also logs to console for local visibility.
 */
export function captureError(
  error: Error | unknown,
  context?: Record<string, unknown>,
): void {
  // Always log locally
  console.error("[Error]", error, context);

  if (!SENTRY_DSN) return;

  if (error instanceof Error) {
    Sentry.captureException(error, {
      extra: context,
    });
  } else {
    Sentry.captureMessage(String(error), {
      level: "error",
      extra: context,
    });
  }
}

/**
 * Capture a message/warning and send to Sentry.
 */
export function captureMessage(
  message: string,
  level: "info" | "warning" | "error" = "warning",
  context?: Record<string, unknown>,
): void {
  console.log(`[${level.toUpperCase()}]`, message, context);

  if (!SENTRY_DSN) return;

  Sentry.captureMessage(message, {
    level,
    extra: context,
  });
}

/**
 * Set user context for error tracking.
 * Call this when a user is authenticated.
 */
export function setUser(did: string, handle?: string): void {
  if (!SENTRY_DSN) return;

  Sentry.setUser({
    id: did,
    username: handle,
  });
}

/**
 * Clear user context (on logout).
 */
export function clearUser(): void {
  if (!SENTRY_DSN) return;

  Sentry.setUser(null);
}

export { Sentry };
