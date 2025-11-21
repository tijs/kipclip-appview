import { Hono } from "https://esm.sh/hono";
import { initializeTables } from "./database/db.ts";
import { oauth } from "./oauth-config.ts";
import { staticRoutes } from "./routes/static.ts";
import { bookmarksApi } from "./routes/bookmarks.ts";
import { tagsApi } from "./routes/tags.ts";
import { sharedApi } from "./routes/shared.ts";
import { rssApi } from "./routes/rss.ts";

// Run database migrations on startup
await initializeTables();

// Create the main app
const app = new Hono();

// Re-export oauth for backward compatibility
export { oauth };

// Note: No canonical-host redirect; app runs purely as a standard website

// Mount OAuth routes (provides /login, /oauth/callback, /api/auth/*)
// @ts-expect-error TS2589: Hono's type inference hits TypeScript's recursion limit with complex nested route types
app.route("/", oauth.routes);

// Mount bookmarks API (uses oauth.sessions internally)
app.route("/api", bookmarksApi);

// Mount tags API
app.route("/api", tagsApi);

// Mount shared bookmarks API (public, no auth)
app.route("/api", sharedApi);

// Mount RSS feeds (must come before static routes to match /share/*/rss)
app.route("/", rssApi);

// Static file serving and SPA routing
app.route("/", staticRoutes);

// Error handler - let errors bubble up with full context
app.onError((err, _c) => {
  console.error("Application error:", err);
  throw err;
});

export default app.fetch;
