import { App } from "jsr:@fresh/core@^2.2.0";
import { initializeTables } from "./database/db.ts";
import { oauth } from "./oauth-config.ts";
import { registerStaticRoutes } from "./routes/static.ts";
import { registerBookmarksRoutes } from "./routes/bookmarks.ts";
import { registerTagsRoutes } from "./routes/tags.ts";
import { registerInitialDataRoutes } from "./routes/initial-data.ts";
import { registerSharedRoutes } from "./routes/shared.ts";
import { registerRssRoutes } from "./routes/rss.ts";
import { registerDebugRoutes } from "./routes/debug.ts";

// Run database migrations on startup
await initializeTables();

// Re-export oauth for backward compatibility
export { oauth };

// Create the Fresh app
let app = new App();

// Error handling middleware
app = app.use(async (ctx) => {
  try {
    return await ctx.next();
  } catch (err) {
    console.error("Application error:", err);
    throw err;
  }
});

// OAuth routes
app = app.get("/login", (ctx) => oauth.handleLogin(ctx.req));
app = app.get("/oauth/callback", (ctx) => oauth.handleCallback(ctx.req));

// Serve static OAuth client metadata (faster than dynamic generation)
app = app.get("/oauth-client-metadata.json", () => {
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
        "Cache-Control": "public, max-age=3600",
      },
    },
  );
});

app = app.post("/api/auth/logout", (ctx) => oauth.handleLogout(ctx.req));

// Serve robots.txt
app = app.get("/robots.txt", () => {
  return new Response(
    `User-agent: *
Allow: /
Disallow: /api/
Disallow: /oauth/

Sitemap: https://kipclip.com/sitemap.xml
`,
    {
      headers: {
        "Content-Type": "text/plain",
        "Cache-Control": "public, max-age=86400",
      },
    },
  );
});

// Session check endpoint
app = app.get("/api/auth/session", async (ctx) => {
  const result = await oauth.getSessionFromRequest(ctx.req);
  if (!result.session) {
    return Response.json(
      { error: result.error?.message || "Not authenticated" },
      { status: 401 },
    );
  }
  const response = Response.json({
    did: result.session.did,
    handle: result.session.handle,
  });
  if (result.setCookieHeader) {
    response.headers.set("Set-Cookie", result.setCookieHeader);
  }
  return response;
});

// Register API routes
app = registerBookmarksRoutes(app);
app = registerTagsRoutes(app);
app = registerInitialDataRoutes(app);
app = registerSharedRoutes(app);
app = registerDebugRoutes(app);

// Register RSS routes (must come before static routes)
app = registerRssRoutes(app);

// Register static file serving and SPA routing (must be last)
app = registerStaticRoutes(app);

// Export handler for Val Town
export default app.handler();
