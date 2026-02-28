/**
 * Preferences API routes.
 * GET /api/preferences — read user preferences from PDS
 * PUT /api/preferences — update user preferences on PDS
 */

import type { App } from "@fresh/core";
import {
  createAuthErrorResponse,
  getSessionFromRequest,
  setSessionCookie,
} from "../../lib/route-utils.ts";
import {
  getUserPreferences,
  updateUserPreferences,
} from "../../lib/preferences.ts";
import { DATE_FORMATS } from "../../shared/date-format.ts";
import type { UpdatePreferencesRequest } from "../../shared/types.ts";

const validDateFormats = new Set<string>(DATE_FORMATS.map((f) => f.id));

export function registerPreferencesRoutes(app: App<any>): App<any> {
  app = app.get("/api/preferences", async (ctx) => {
    try {
      const { session: oauthSession, setCookieHeader, error } =
        await getSessionFromRequest(ctx.req);

      if (!oauthSession) {
        return createAuthErrorResponse(error);
      }

      const preferences = await getUserPreferences(oauthSession);
      return setSessionCookie(
        Response.json({ preferences }),
        setCookieHeader,
      );
    } catch (error: any) {
      console.error("Error fetching preferences:", error);
      return Response.json({ error: error.message }, { status: 500 });
    }
  });

  app = app.put("/api/preferences", async (ctx) => {
    try {
      const { session: oauthSession, setCookieHeader, error } =
        await getSessionFromRequest(ctx.req);

      if (!oauthSession) {
        return createAuthErrorResponse(error);
      }

      const body = (await ctx.req.json()) as UpdatePreferencesRequest;

      if (body.dateFormat && !validDateFormats.has(body.dateFormat)) {
        return Response.json(
          { success: false, error: "Invalid date format" },
          { status: 400 },
        );
      }

      const preferences = await updateUserPreferences(oauthSession, body);
      return setSessionCookie(
        Response.json({ success: true, preferences }),
        setCookieHeader,
      );
    } catch (error: any) {
      console.error("Error updating preferences:", error);
      return Response.json(
        { success: false, error: error.message },
        { status: 500 },
      );
    }
  });

  return app;
}
