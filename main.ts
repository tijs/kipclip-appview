/**
 * Main entry point for kipclip Fresh application.
 * Orchestrates route registration and middleware setup.
 */

// Load environment variables from .env file (local development)
import { load } from "@std/dotenv";
try {
  await load({ export: true });
  console.log("✅ Loaded .env file");
} catch (error) {
  console.warn("⚠️ Failed to load .env file:", error.message);
}

import { App, staticFiles } from "@fresh/core";
import { initializeTables } from "./lib/db.ts";
import { initOAuth } from "./lib/oauth-config.ts";
import { captureError } from "./lib/sentry.ts";

// Route modules
import { registerAuthRoutes } from "./routes/api/auth.ts";
import { registerBookmarkRoutes } from "./routes/api/bookmarks.ts";
import { registerInitialDataRoutes } from "./routes/api/initial-data.ts";
import { registerSettingsRoutes } from "./routes/api/settings.ts";
import { registerShareApiRoutes } from "./routes/api/share.ts";
import { registerTagRoutes } from "./routes/api/tags.ts";
import { registerOAuthRoutes } from "./routes/oauth.ts";
import { registerRssRoutes } from "./routes/share/rss.ts";
import { registerShareTargetRoutes } from "./routes/share-target.ts";
import { registerStaticRoutes } from "./routes/static.ts";

// Run database migrations on startup
await initializeTables();

// Create the Fresh app
let app = new App();

// ============================================================================
// Middleware
// ============================================================================

// Error handling middleware
app = app.use(async (ctx) => {
  try {
    return await ctx.next();
  } catch (err) {
    captureError(err, { url: ctx.req.url, method: ctx.req.method });
    throw err;
  }
});

// Initialize OAuth on first request (derives BASE_URL from request if not set)
app = app.use(async (ctx) => {
  initOAuth(ctx.req);
  return await ctx.next();
});

// Security headers middleware
app = app.use(async (ctx) => {
  const response = await ctx.next();

  // Prevent clickjacking
  response.headers.set("X-Frame-Options", "DENY");

  // Prevent MIME type sniffing
  response.headers.set("X-Content-Type-Options", "nosniff");

  // Control referrer information
  response.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");

  // HTTPS enforcement (1 year)
  response.headers.set(
    "Strict-Transport-Security",
    "max-age=31536000; includeSubDomains",
  );

  // Restrict browser features
  response.headers.set(
    "Permissions-Policy",
    "camera=(), microphone=(), geolocation=()",
  );

  return response;
});

// Serve static files from /static directory (Fresh built-in)
app.use(staticFiles());

// ============================================================================
// Register routes
// ============================================================================

// OAuth routes (login, callback, metadata)
app = registerOAuthRoutes(app);

// Auth API routes (session, logout)
app = registerAuthRoutes(app);

// Bookmark API routes
app = registerBookmarkRoutes(app);

// Tag API routes
app = registerTagRoutes(app);

// Initial data API route (combined bookmarks + tags + settings)
app = registerInitialDataRoutes(app);

// Settings API routes
app = registerSettingsRoutes(app);

// Share API routes (public bookmark sharing)
app = registerShareApiRoutes(app);

// RSS feed routes
app = registerRssRoutes(app);

// Share target routes (PWA share functionality)
app = registerShareTargetRoutes(app);

// Static files and SPA routing (must be last)
app = registerStaticRoutes(app, import.meta.url);

// Export app for Fresh build system
export { app };
