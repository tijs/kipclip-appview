/**
 * Public mentions endpoint.
 *
 *   GET /api/mentions -- Bluesky posts that link to kipclip.com,
 *                        cached for 24h. Backed by lib/mentions.ts.
 *                        Distinct from /api/reviews — see that lib for
 *                        formal atstore review records.
 */

import type { App } from "@fresh/core";
import { getMentions } from "../../lib/mentions.ts";

export function registerMentionsRoutes(app: App<unknown>): App<unknown> {
  app = app.get("/api/mentions", async () => {
    const { data, stale } = await getMentions();
    const headers = new Headers({ "Content-Type": "application/json" });
    headers.set(
      "Cache-Control",
      "public, max-age=60, stale-while-revalidate=600",
    );
    return new Response(JSON.stringify({ mentions: data, stale }), { headers });
  });
  return app;
}
