import { Hono } from "https://esm.sh/hono";
import {
  createATProtoOAuth,
  SQLiteStorage,
} from "jsr:@tijs/atproto-oauth-hono@2.0.10";
import { initializeTables, rawDb } from "./database/db.ts";
import { staticRoutes } from "./routes/static.ts";
import { bookmarksApi } from "./routes/bookmarks.ts";
import { tagsApi } from "./routes/tags.ts";
import { sharedApi } from "./routes/shared.ts";
import { rssApi } from "./routes/rss.ts";

// Run database migrations on startup
await initializeTables();

// Create the main app
const app = new Hono();

// Get base URL and cookie secret from environment
const BASE_URL = Deno.env.get("BASE_URL") ||
  "https://kipclip-tijs.val.town";
const COOKIE_SECRET = Deno.env.get("COOKIE_SECRET");

if (!COOKIE_SECRET) {
  throw new Error("COOKIE_SECRET environment variable is required");
}

// Create OAuth integration with SQLiteStorage
export const oauth = createATProtoOAuth({
  baseUrl: BASE_URL,
  appName: "kipclip",
  cookieSecret: COOKIE_SECRET,
  sessionTtl: 60 * 60 * 24 * 30, // 30 days in seconds
  storage: new SQLiteStorage(rawDb),
  logger: console, // Explicit logger for better debugging
});

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
