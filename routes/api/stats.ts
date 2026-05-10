/**
 * Public site-wide marketing stats.
 *
 *   GET /api/stats -- returns total user count (distinct DIDs that
 *                     have ever signed in). Cached for 24h. Backed by
 *                     lib/stats.ts so other surfaces can reuse it.
 */

import type { App } from "@fresh/core";
import { getStats } from "../../lib/stats.ts";

export function registerStatsRoutes(app: App<unknown>): App<unknown> {
  app = app.get("/api/stats", async () => {
    const { data, stale } = await getStats();
    const headers = new Headers({ "Content-Type": "application/json" });
    headers.set(
      "Cache-Control",
      "public, max-age=60, stale-while-revalidate=600",
    );
    return new Response(
      JSON.stringify({ userCount: data.userCount, stale }),
      { headers },
    );
  });
  return app;
}
