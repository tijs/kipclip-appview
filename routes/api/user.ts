/**
 * User-scoped API routes.
 * GET /api/user/supporter-status — re-query supporter status from PDS
 * (bypassing the server cache) and return {isSupporter}.
 */

import type { App } from "@fresh/core";
import {
  createAuthErrorResponse,
  getSessionFromRequest,
  setSessionCookie,
} from "../../lib/route-utils.ts";
import { isUserSupporter } from "../../lib/atprotofans.ts";
import type { SupporterStatusResponse } from "../../shared/types.ts";

export function registerUserRoutes(app: App<any>): App<any> {
  app = app.get("/api/user/supporter-status", async (ctx) => {
    try {
      const { session: oauthSession, setCookieHeader, error } =
        await getSessionFromRequest(ctx.req);
      if (!oauthSession) {
        return createAuthErrorResponse(error);
      }

      const isSupporter = await isUserSupporter(oauthSession, {
        bypassCache: true,
      });

      const resp: SupporterStatusResponse = { isSupporter };
      return setSessionCookie(Response.json(resp), setCookieHeader);
    } catch (err: any) {
      console.error("Supporter status error:", err);
      return Response.json({ error: err.message }, { status: 500 });
    }
  });

  return app;
}
