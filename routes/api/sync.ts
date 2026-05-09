/**
 * Sync API routes for the AppView mirror.
 *
 *   POST /api/sync/track   — register caller's DID with TAP for live sync.
 *   GET  /api/sync/status  — read mirror sync state for caller's DID.
 *   POST /api/sync/hook    — TAP webhook receiver (localhost-only).
 *
 * Production rules:
 *   - /track and /status: session-authed; caller may only act on their own DID.
 *   - /hook: gated by a loopback ipFilter (allowList 127.0.0.1, ::1) plus
 *     Basic-auth inside handleWebhookRequest. No public exposure (R23).
 *   - /track refuses if the TAP control call fails so we never store a row
 *     TAP doesn't know about (no orphans).
 */

import { type App, ipFilter } from "@fresh/core";
import {
  createAuthErrorResponse,
  setSessionCookie,
} from "../../lib/route-utils.ts";
import { getSessionFromRequest } from "../../lib/session.ts";
import { getSyncStatus } from "../../mirror/queries.ts";
import { insertTrackedDidForEnrollment } from "../../mirror/upserts.ts";
import { handleWebhookRequest } from "../../worker/webhook.ts";

const TAP_CONTROL_URL = Deno.env.get("TAP_CONTROL_URL") ??
  "http://127.0.0.1:2480";
const TAP_ADMIN_PASSWORD = Deno.env.get("TAP_ADMIN_PASSWORD");

async function tapTrackDid(
  did: string,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (TAP_ADMIN_PASSWORD) {
      headers.Authorization = "Basic " +
        btoa(`admin:${TAP_ADMIN_PASSWORD}`);
    }
    const r = await fetch(`${TAP_CONTROL_URL}/repos/add`, {
      method: "POST",
      headers,
      body: JSON.stringify({ dids: [did] }),
    });
    if (!r.ok) {
      return { ok: false, error: `TAP control returned ${r.status}` };
    }
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export function registerSyncRoutes(app: App<unknown>): App<unknown> {
  // Loopback-only allowlist on the TAP webhook. On the Hetzner box this is
  // belt-and-suspenders behind Caddy's 403 on public hosts; on Deno Deploy
  // (no Caddy in front) it is the primary gate. Note: when Caddy proxies
  // external traffic to localhost, those requests also arrive as 127.0.0.1,
  // so this filter does not distinguish TAP from Caddy-forwarded requests —
  // the Basic-auth check inside handleWebhookRequest is the actual TAP gate.
  app = app.use(
    "/api/sync/hook",
    ipFilter({ allowList: ["127.0.0.1", "::1"] }),
  );

  app = app.post("/api/sync/track", async (ctx) => {
    try {
      const { session, setCookieHeader, error } = await getSessionFromRequest(
        ctx.req,
      );
      if (!session) return createAuthErrorResponse(error);

      const body = await ctx.req.json().catch(() => null) as
        | { did?: string; pdsUrl?: string }
        | null;
      if (!body || typeof body.did !== "string") {
        return Response.json({ error: "Missing did" }, { status: 400 });
      }

      if (body.did !== session.did) {
        return Response.json(
          { error: "Cannot track another DID" },
          { status: 403 },
        );
      }

      const tapResult = await tapTrackDid(body.did);
      if (!tapResult.ok) {
        return Response.json(
          { error: "TAP unavailable", detail: tapResult.error },
          { status: 502 },
        );
      }

      await insertTrackedDidForEnrollment({
        did: body.did,
        pdsUrl: body.pdsUrl ?? session.pdsUrl ?? null,
        backfillStartedAt: Date.now(),
      });

      return setSessionCookie(
        Response.json({ tracking: true, did: body.did }),
        setCookieHeader,
      );
    } catch (err) {
      console.error("[sync/track]", err);
      return Response.json(
        { error: err instanceof Error ? err.message : String(err) },
        { status: 500 },
      );
    }
  });

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
