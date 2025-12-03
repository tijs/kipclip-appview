/**
 * Debug endpoints for troubleshooting authentication issues.
 * Only accessible in development or with debug flag.
 */

import type { App } from "jsr:@fresh/core@^2.2.0";

// Fresh App with any state type (we don't use Fresh's state management)
type FreshApp = App<any>;
import { getSessionFromRequest } from "../utils/session.ts";

/**
 * Register debug routes on the Fresh app
 */
export function registerDebugRoutes(app: FreshApp): FreshApp {
  /**
   * Debug endpoint to diagnose session issues.
   * Returns detailed information about the current session state.
   */
  app = app.get("/api/auth/debug", async (ctx) => {
    const request = ctx.req;
    const cookies = request.headers.get("cookie") || "";
    const hasSidCookie = cookies.includes("sid=");
    const sidCookiePreview = cookies.match(/sid=([^;]+)/)?.[1]?.substring(
      0,
      30,
    );

    // Try to get session
    const { session, error } = await getSessionFromRequest(request);

    return Response.json({
      debug: {
        timestamp: new Date().toISOString(),
        url: request.url,
        cookies: {
          hasSidCookie,
          sidCookiePreview: sidCookiePreview ? `${sidCookiePreview}...` : null,
        },
        session: session
          ? {
            did: session.did,
            pdsUrl: session.pdsUrl,
          }
          : null,
        error: error || null,
      },
    });
  });

  return app;
}
