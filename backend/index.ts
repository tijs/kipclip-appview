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
// Serve static OAuth client metadata (faster than dynamic generation)
app.get("/oauth-client-metadata.json", () => {
  return new Response(
    JSON.stringify({
      client_name: "kipclip",
      client_id: "https://kipclip.com/oauth-client-metadata.json",
      client_uri: "https://kipclip.com",
      redirect_uris: ["https://kipclip.com/oauth/callback"],
      scope: "atproto transition:generic",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      application_type: "web",
      token_endpoint_auth_method: "none",
      dpop_bound_access_tokens: true,
      logo_uri: "https://cdn.kipclip.com/images/kip-vignette.png",
    }),
    {
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=3600", // Cache for 1 hour
      },
    },
  );
});
app.post("/api/auth/logout", (c) => oauth.handleLogout(c.req.raw));

// Session check endpoint (app-specific, returns { did, handle } for frontend)
app.get("/api/auth/session", async (c) => {
  const result = await oauth.getSessionFromRequest(c.req.raw);
  if (!result.session) {
    return c.json({ error: result.error?.message || "Not authenticated" }, 401);
  }
  const response = c.json({
    did: result.session.did,
    handle: result.session.handle,
  });
  if (result.setCookieHeader) {
    response.headers.set("Set-Cookie", result.setCookieHeader);
  }
  return response;
});

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
