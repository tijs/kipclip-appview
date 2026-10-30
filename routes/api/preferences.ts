/**
 * Preferences API routes.
 * GET /api/preferences — read user preferences from PDS
 * PUT /api/preferences — update user preferences on PDS
 */

import type { App } from "../../lib/http-app.ts";
import {
  createAuthErrorResponse,
  getSessionFromRequest,
  setSessionCookie,
} from "../../lib/route-utils.ts";
import {
  getDomainTagRules,
  getUserPreferences,
  PreferenceConflictError,
  writeUserPreferences,
} from "../../lib/preferences.ts";
import { DATE_FORMATS } from "../../shared/date-format.ts";
import { validateDomainTagRules } from "../../shared/domain-tag-rules.ts";
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

  app = app.get("/api/preferences/domain-tags", async (ctx) => {
    try {
      const { session, setCookieHeader, error } = await getSessionFromRequest(
        ctx.req,
      );
      if (!session) return createAuthErrorResponse(error);
      return setSessionCookie(
        Response.json(await getDomainTagRules(session)),
        setCookieHeader,
      );
    } catch {
      return Response.json({ error: "Could not load site tag rules" }, {
        status: 503,
      });
    }
  });

  app = app.put("/api/preferences", async (ctx) => {
    try {
      const { session: oauthSession, setCookieHeader, error } =
        await getSessionFromRequest(ctx.req);

      if (!oauthSession) {
        return createAuthErrorResponse(error);
      }

      const body = (await ctx.req.json()) as UpdatePreferencesRequest & {
        domainRulesRevision?: string | null;
      };
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        return Response.json({ error: "Invalid preferences" }, { status: 400 });
      }

      if (
        body.domainTagRules !== undefined &&
        !validateDomainTagRules(body.domainTagRules)
      ) {
        return Response.json({
          success: false,
          error: "Invalid domain tag rules",
        }, { status: 400 });
      }
      if (
        body.domainTagRules !== undefined &&
        !(body.domainRulesRevision === null ||
          (typeof body.domainRulesRevision === "string" &&
            body.domainRulesRevision.length > 0))
      ) {
        return Response.json({ error: "A rules revision is required" }, {
          status: 400,
        });
      }

      if (
        body.dateFormat !== undefined &&
        (typeof body.dateFormat !== "string" ||
          !validDateFormats.has(body.dateFormat))
      ) {
        return Response.json(
          { success: false, error: "Invalid date format" },
          { status: 400 },
        );
      }

      if (body.readingListTag !== undefined) {
        if (typeof body.readingListTag !== "string") {
          return Response.json({ success: false, error: "Invalid tag" }, {
            status: 400,
          });
        }
        const tag = body.readingListTag.trim();
        if (tag.length === 0 || tag.length > 64) {
          return Response.json(
            { success: false, error: "Tag must be 1-64 characters" },
            { status: 400 },
          );
        }
        if (!/^[a-zA-Z0-9_-]+$/.test(tag)) {
          return Response.json(
            {
              success: false,
              error:
                "Tag can only contain letters, numbers, dashes, and underscores",
            },
            { status: 400 },
          );
        }
        body.readingListTag = tag;
      }

      const updates: UpdatePreferencesRequest = {};
      if (body.dateFormat !== undefined) updates.dateFormat = body.dateFormat;
      if (body.readingListTag !== undefined) {
        updates.readingListTag = body.readingListTag;
      }
      if (body.domainTagRules !== undefined) {
        updates.domainTagRules = body.domainTagRules;
      }
      const result = await writeUserPreferences(
        oauthSession,
        updates,
        body.domainTagRules !== undefined
          ? body.domainRulesRevision
          : undefined,
      );
      const preferences = result.preferences;
      const domainRules = body.domainTagRules !== undefined && result.cid
        ? { rules: preferences.domainTagRules ?? [], cid: result.cid }
        : undefined;
      return setSessionCookie(
        Response.json({ success: true, preferences, domainRules }),
        setCookieHeader,
      );
    } catch (error: any) {
      console.error("Error updating preferences:", error);
      return Response.json(
        { success: false, error: error.message },
        { status: error instanceof PreferenceConflictError ? 409 : 500 },
      );
    }
  });

  return app;
}
