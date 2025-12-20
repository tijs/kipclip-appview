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
import { validateInstapaperCredentials } from "../../lib/instapaper.ts";
import { decrypt } from "../../lib/encryption.ts";
import { rawDb } from "../../lib/db.ts";
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

      const body = (await ctx.req.json()) as UpdateSettingsRequest & {
        instapaperPassword?: string;
      };

      // Validate Instapaper credentials if enabling or updating
      if (
        body.instapaperEnabled &&
        (body.instapaperUsername || body.instapaperPassword)
      ) {
        // Need both username and password for validation
        let username = body.instapaperUsername;
        let password = body.instapaperPassword;

        // If only one is provided, fetch the other from existing settings
        if (!username || !password) {
          const existingSettings = await getUserSettings(oauthSession.did);
          username = username || existingSettings.instapaperUsername;
          password = password ||
            (await getInstapaperPassword(oauthSession.did));
        }

        if (username && password) {
          const validation = await validateInstapaperCredentials({
            username,
            password,
          });

          if (!validation.valid) {
            const result: UpdateSettingsResponse = {
              success: false,
              error: validation.error || "Invalid Instapaper credentials",
            };
            return Response.json(result, { status: 400 });
          }
        }
      }

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

/**
 * Helper function to get encrypted password for validation.
 */
async function getInstapaperPassword(
  did: string,
): Promise<string | undefined> {
  const result = await rawDb.execute({
    sql:
      "SELECT instapaper_password_encrypted FROM user_settings WHERE did = ?",
    args: [did],
  });

  if (result.rows?.[0]?.[0]) {
    try {
      return await decrypt(result.rows[0][0] as string);
    } catch (error) {
      console.error("Failed to decrypt Instapaper password:", error);
    }
  }

  return undefined;
}
