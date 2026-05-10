/**
 * Auth API routes.
 * Handles session management.
 */

import type { App } from "@fresh/core";
import { getOAuth } from "../../lib/oauth-config.ts";
import { markSeenDid } from "../../lib/seen-dids.ts";

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
    // Persist this DID to the seen_dids ledger so the marketing user
    // count stays accurate even after iron_session_storage prunes
    // expired sessions. Fire-and-forget — we never block the auth
    // response on a metrics write.
    markSeenDid(result.session.did).catch(() => {});
    const response = Response.json({
      did: result.session.did,
      handle: result.session.handle,
    });
    if (result.setCookieHeader) {
      response.headers.set("Set-Cookie", result.setCookieHeader);
    }
    return response;
  });

  return app;
}
