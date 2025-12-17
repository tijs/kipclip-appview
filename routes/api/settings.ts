/**
 * Settings API routes.
 * Handles user settings management.
 */

import type { App } from "@fresh/core";
import {
  createAuthErrorResponse,
  getSessionFromRequest,
  setSessionCookie,
} from "../../lib/route-utils.ts";
import { getUserSettings, updateUserSettings } from "../../lib/settings.ts";
import type {
  GetSettingsResponse,
  UpdateSettingsRequest,
  UpdateSettingsResponse,
} from "../../shared/types.ts";

export function registerSettingsRoutes(app: App<any>): App<any> {
  // Get user settings
  app = app.get("/api/settings", async (ctx) => {
    try {
      const { session: oauthSession, setCookieHeader, error } =
        await getSessionFromRequest(ctx.req);

      if (!oauthSession) {
        return createAuthErrorResponse(error);
      }

      const settings = await getUserSettings(oauthSession.did);
      const result: GetSettingsResponse = { settings };
      return setSessionCookie(Response.json(result), setCookieHeader);
    } catch (error: any) {
      console.error("Error fetching settings:", error);
      return Response.json({ error: error.message }, { status: 500 });
    }
  });

  // Update user settings
  app = app.patch("/api/settings", async (ctx) => {
    try {
      const { session: oauthSession, setCookieHeader, error } =
        await getSessionFromRequest(ctx.req);

      if (!oauthSession) {
        return createAuthErrorResponse(error);
      }

      const body = (await ctx.req.json()) as UpdateSettingsRequest;
      const settings = await updateUserSettings(oauthSession.did, body);
      const result: UpdateSettingsResponse = { success: true, settings };
      return setSessionCookie(Response.json(result), setCookieHeader);
    } catch (error: any) {
      console.error("Error updating settings:", error);
      const result: UpdateSettingsResponse = {
        success: false,
        error: error.message,
      };
      return Response.json(result, { status: 400 });
    }
  });

  return app;
}
