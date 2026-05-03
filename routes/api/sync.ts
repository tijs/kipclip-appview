/**
 * Sync API routes for the AppView mirror.
 *
 *   POST /api/sync/track   — register caller's DID with TAP for live sync.
 *   GET  /api/sync/status  — read mirror sync state for caller's DID.
 *   POST /api/sync/hook    — TAP webhook receiver (localhost-only).
 *
 * Production rules:
 *   - /track and /status: session-authed; caller may only act on their own DID.
 *   - /hook: bound to localhost-only Host header. No public exposure (R23).
 *   - /track refuses if the TAP control call fails so we never store a row
 *     TAP doesn't know about (no orphans).
 */

import type { App } from "@fresh/core";
import {
  createAuthErrorResponse,
  setSessionCookie,
} from "../../lib/route-utils.ts";
import { getSessionFromRequest } from "../../lib/session.ts";
import { getSyncStatus } from "../../mirror/queries.ts";
import { upsertTrackedDid } from "../../mirror/upserts.ts";
import { handleWebhookRequest } from "../../worker/webhook.ts";

const TAP_CONTROL_URL = Deno.env.get("TAP_CONTROL_URL") ??
  "http://127.0.0.1:7000";

async function tapTrackDid(
  did: string,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const r = await fetch(`${TAP_CONTROL_URL}/admin/track`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ did }),
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

function isLocalhostHostname(hostname: string): boolean {
  return hostname === "127.0.0.1" || hostname === "localhost" ||
    hostname === "::1";
}

export function registerSyncRoutes(app: App<unknown>): App<unknown> {
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

      await upsertTrackedDid({
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

  app = app.post("/api/sync/hook", (ctx) => {
    const url = new URL(ctx.req.url);
    if (!isLocalhostHostname(url.hostname)) {
      return Response.json(
        { error: "Webhook endpoint is localhost-only" },
        { status: 403 },
      );
    }
    return handleWebhookRequest(ctx.req);
  });

  return app;
}
