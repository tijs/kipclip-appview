/**
 * Public supporters endpoint.
 *
 *   GET /api/supporters -- Latest atprotofans supporters of kipclip,
 *                          hydrated through bsky public app view.
 *                          Cached for 24h. Backed by lib/supporters.ts
 *                          so the same data can be reused elsewhere
 *                          on the site (Settings → Supporter, etc).
 */

import type { App } from "@fresh/core";
import { getSupporters } from "../../lib/supporters.ts";

export function registerSupportersRoutes(app: App<unknown>): App<unknown> {
  app = app.get("/api/supporters", async () => {
    const { data, stale } = await getSupporters();
    const headers = new Headers({ "Content-Type": "application/json" });
    headers.set(
      "Cache-Control",
      "public, max-age=60, stale-while-revalidate=600",
    );
    return new Response(
      JSON.stringify({
        supporters: data.supporters,
        totalCount: data.totalCount,
        stale,
      }),
      { headers },
    );
  });
  return app;
}
