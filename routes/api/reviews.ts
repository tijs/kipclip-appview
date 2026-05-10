/**
 * Public reviews endpoint.
 *
 *   GET /api/reviews -- Bluesky posts that link to kipclip.com,
 *                       cached for 24h. Backed by lib/reviews.ts so
 *                       the same data can be reused server-side
 *                       elsewhere on the site.
 */

import type { App } from "@fresh/core";
import { getReviews } from "../../lib/reviews.ts";

export function registerReviewsRoutes(app: App<unknown>): App<unknown> {
  app = app.get("/api/reviews", async () => {
    const { data, stale } = await getReviews();
    const headers = new Headers({ "Content-Type": "application/json" });
    // Short browser TTL — server keeps a 24h in-memory cache so the
    // upstream isn't hit per request. Browser revalidates often so
    // updates appear quickly without hard reloads.
    headers.set(
      "Cache-Control",
      "public, max-age=60, stale-while-revalidate=600",
    );
    return new Response(JSON.stringify({ reviews: data, stale }), { headers });
  });
  return app;
}
