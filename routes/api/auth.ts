/**
 * Auth API routes.
 * Handles session management and debugging.
 */

import type { App } from "@fresh/core";
import { getOAuth } from "../../lib/oauth-config.ts";
import { getSessionFromRequest } from "../../lib/route-utils.ts";

export function registerAuthRoutes(app: App<any>): App<any> {
  // Logout
  app = app.post("/api/auth/logout", (ctx) => getOAuth().handleLogout(ctx.req));

  // Get session info
  app = app.get("/api/auth/session", async (ctx) => {
    const result = await getOAuth().getSessionFromRequest(ctx.req);
    if (!result.session) {
      return Response.json(
        { error: result.error?.message || "Not authenticated" },
        { status: 401 },
      );
    }
    const response = Response.json({
      did: result.session.did,
      handle: result.session.handle,
    });
    if (result.setCookieHeader) {
      response.headers.set("Set-Cookie", result.setCookieHeader);
    }
    return response;
  });

  // Debug endpoint
  app = app.get("/api/auth/debug", async (ctx) => {
    const request = ctx.req;
    const cookies = request.headers.get("cookie") || "";
    const hasSidCookie = cookies.includes("sid=");
    const sidCookiePreview = cookies.match(/sid=([^;]+)/)?.[1]?.substring(
      0,
      30,
    );

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
