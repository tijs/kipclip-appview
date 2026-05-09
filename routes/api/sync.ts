/**
 * Sync API routes for the AppView mirror.
 *
 *   GET  /api/sync/status  — read mirror sync state for caller's DID.
 *   POST /api/sync/hook    — TAP webhook receiver (localhost-only).
 *
 * Production rules:
 *   - /status: session-authed; caller may only query their own DID.
 *   - /hook: gated by a loopback ipFilter (allowList 127.0.0.1, ::1) plus
 *     Basic-auth inside handleWebhookRequest. No public exposure (R23).
 */

import { type App, ipFilter } from "@fresh/core";
import {
  createAuthErrorResponse,
  setSessionCookie,
} from "../../lib/route-utils.ts";
import { getSessionFromRequest } from "../../lib/session.ts";
import { getSyncStatus } from "../../mirror/queries.ts";
import { handleWebhookRequest } from "../../worker/webhook.ts";

export function registerSyncRoutes(app: App<unknown>): App<unknown> {
  // Loopback-only allowlist on the TAP webhook. Belt-and-suspenders behind
  // Caddy's 403 on public hosts. Note: when Caddy proxies external traffic to
  // localhost, those requests also arrive as 127.0.0.1, so this filter does
  // not distinguish TAP from Caddy-forwarded requests — the Basic-auth check
  // inside handleWebhookRequest is the actual TAP gate.
  app = app.use(
    "/api/sync/hook",
    ipFilter({ allowList: ["127.0.0.1", "::1"] }),
  );

  app = app.get("/api/sync/status", async (ctx) => {
    try {
      const { session, setCookieHeader, error } = await getSessionFromRequest(
        ctx.req,
      );
      if (!session) return createAuthErrorResponse(error);

      const url = new URL(ctx.req.url);
      const queryDid = url.searchParams.get("did");
      const did = queryDid ?? session.did;

      if (did !== session.did) {
        return Response.json(
          { error: "Cannot query another DID" },
          { status: 403 },
        );
      }

      const status = await getSyncStatus(did);
      return setSessionCookie(Response.json(status), setCookieHeader);
    } catch (err) {
      console.error("[sync/status]", err);
      return Response.json(
        { error: err instanceof Error ? err.message : String(err) },
        { status: 500 },
      );
    }
  });

  app = app.post("/api/sync/hook", (ctx) => handleWebhookRequest(ctx.req));

  return app;
}
