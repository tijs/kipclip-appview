/**
 * Public site-wide marketing stats.
 *
 *   GET /api/stats          -- total user count (distinct DIDs that
 *                              have ever signed in). Cached for 24h.
 *                              Backed by lib/stats.ts.
 *   GET /api/stats/monthly  -- per-month MAU + signups for the last
 *                              ?months=N calendar months (default 12,
 *                              capped at MAX_MONTHS). Cached for 1h.
 *                              Backed by lib/stats-monthly.ts. See that
 *                              module for the iron_session_storage TTL
 *                              and seen_dids backfill caveats.
 */

import type { App } from "@fresh/core";
import { getStats } from "../../lib/stats.ts";
import { getMonthlyStats, MAX_MONTHS } from "../../lib/stats-monthly.ts";

export function registerStatsRoutes(app: App<unknown>): App<unknown> {
  app = app.get("/api/stats", async () => {
    const { data, stale } = await getStats();
    const headers = new Headers({ "Content-Type": "application/json" });
    headers.set(
      "Cache-Control",
      "public, max-age=60, stale-while-revalidate=600",
    );
    return new Response(
      JSON.stringify({
        userCount: data.userCount,
        bySource: data.bySource,
        stale,
      }),
      { headers },
    );
  });

  app = app.get("/api/stats/monthly", async (ctx) => {
    const raw = new URL(ctx.req.url).searchParams.get("months");
    const months = raw === null ? 12 : Number(raw);
    if (!Number.isFinite(months) || months < 1 || months > MAX_MONTHS) {
      return new Response(
        JSON.stringify({
          error: `months must be an integer between 1 and ${MAX_MONTHS}`,
        }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }
    const { data, stale } = await getMonthlyStats(months);
    const headers = new Headers({ "Content-Type": "application/json" });
    headers.set(
      "Cache-Control",
      "public, max-age=300, stale-while-revalidate=3600",
    );
    return new Response(
      JSON.stringify({
        months: data.months,
        currentYearMonth: data.currentYearMonth,
        stale,
      }),
      { headers },
    );
  });

  return app;
}
