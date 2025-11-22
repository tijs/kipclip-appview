/**
 * Debug endpoints for troubleshooting authentication issues.
 * Only accessible in development or with debug flag.
 */

import { Hono } from "https://esm.sh/hono";
import { getSessionFromRequest } from "../utils/session.ts";

export const debugApi = new Hono();

/**
 * Debug endpoint to diagnose session issues.
 * Returns detailed information about the current session state.
 */
debugApi.get("/auth/debug", async (c) => {
  const request = c.req.raw;
  const cookies = request.headers.get("cookie") || "";
  const hasSidCookie = cookies.includes("sid=");
  const sidCookiePreview = cookies.match(/sid=([^;]+)/)?.[1]?.substring(0, 30);

  // Try to get session
  const { session, error } = await getSessionFromRequest(request);

  return c.json({
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
