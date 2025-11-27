import { Hono } from "https://esm.sh/hono";
import { initializeTables } from "./database/db.ts";
import { oauth } from "./oauth-config.ts";
import { staticRoutes } from "./routes/static.ts";
import { bookmarksApi } from "./routes/bookmarks.ts";
import { tagsApi } from "./routes/tags.ts";
import { initialDataApi } from "./routes/initial-data.ts";
import { sharedApi } from "./routes/shared.ts";
import { rssApi } from "./routes/rss.ts";
import { debugApi } from "./routes/debug.ts";

// Run database migrations on startup
await initializeTables();

// Create the main app
const app = new Hono();

// Re-export oauth for backward compatibility
export { oauth };

// Note: No canonical-host redirect; app runs purely as a standard website

// OAuth routes (provides /login, /oauth/callback, /oauth-client-metadata.json, /api/auth/logout)
app.get("/login", (c) => oauth.handleLogin(c.req.raw));
app.get("/oauth/callback", (c) => oauth.handleCallback(c.req.raw));
app.get("/oauth-client-metadata.json", () => oauth.handleClientMetadata());
app.post("/api/auth/logout", (c) => oauth.handleLogout(c.req.raw));

// Mount bookmarks API (uses oauth.sessions internally)
app.route("/api", bookmarksApi);

// Mount tags API
app.route("/api", tagsApi);

// Mount initial data API (combined bookmarks + tags for optimized page load)
app.route("/api", initialDataApi);

// Mount shared bookmarks API (public, no auth)
app.route("/api", sharedApi);

// Mount debug API (for troubleshooting)
app.route("/api", debugApi);

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
