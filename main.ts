/**
 * Main entry point for kipclip Fresh application.
 * Orchestrates route registration and middleware setup.
 */

import { App, staticFiles } from "@fresh/core";
// Static import required — dynamic import inside a conditional is not bundled
// by Deno Deploy. The load() call is gated instead (not the import).
import { load } from "@std/dotenv";
import { initializeTables } from "./lib/db.ts";
import { logMirrorMode } from "./lib/mirror-config.ts";
import { initOAuth, tryInitOAuthFromEnv } from "./lib/oauth-config.ts";
import { captureError } from "./lib/sentry.ts";

// Route modules
import { registerAuthRoutes } from "./routes/api/auth.ts";
import { registerBookmarkRoutes } from "./routes/api/bookmarks.ts";
import { registerInitialDataRoutes } from "./routes/api/initial-data.ts";
import { registerLiveRoutes } from "./routes/api/live.ts";
import { registerSettingsRoutes } from "./routes/api/settings.ts";
import { registerBulkRoutes } from "./routes/api/bulk.ts";
import { registerImportRoutes } from "./routes/api/import.ts";
import { registerMetricsRoutes } from "./routes/api/metrics.ts";
import { registerMigrateHexRkeysRoute } from "./routes/api/migrate-hex-rkeys.ts";
import { registerPreferencesRoutes } from "./routes/api/preferences.ts";
import { registerShareApiRoutes } from "./routes/api/share.ts";
import { registerSyncRoutes } from "./routes/api/sync.ts";
import { registerSystemRoutes } from "./routes/api/system.ts";
import { registerTagRoutes } from "./routes/api/tags.ts";
import { registerUserRoutes } from "./routes/api/user.ts";
import { registerOAuthRoutes } from "./routes/oauth.ts";
import { registerRssRoutes } from "./routes/share/rss.ts";
import { registerShareTargetRoutes } from "./routes/share-target.ts";
import { registerStaticRoutes } from "./routes/static.ts";

// Load environment variables from .env file (local development).
// Skipped under KIPCLIP_TESTING — tests set every env var they need on the
// `deno task test` command line, and loading .env here would bring back
// the developer's real SENTRY_DSN even after tests/test-setup.ts opted out.
if (!Deno.env.get("KIPCLIP_TESTING")) {
  try {
    await load({ export: true });
    console.log("✅ Loaded .env file");
  } catch (error) {
    console.warn("⚠️ Failed to load .env file:", (error as Error).message);
  }
}

// Run database migrations on startup
await initializeTables();

// Log the active mirror mode so deploys make config visible in journalctl
logMirrorMode();

// Create the Fresh app.
// trustProxy applies X-Forwarded-Proto and X-Forwarded-Host to ctx.url
// before handlers see it. Assumes a trusted reverse proxy is in front
// (Caddy on the Hetzner box, Deno Deploy's edge on the warm standby) —
// running this app bare on a public interface would let attackers spoof
// the scheme/host via forged headers.
let app = new App({ trustProxy: true });

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

// Eagerly initialize OAuth at startup when BASE_URL env is set. When unset
// (e.g. local dev without BASE_URL), fall back to a one-shot per-request
// init that derives BASE_URL from ctx.url.
const oauthEagerInit = tryInitOAuthFromEnv();
if (!oauthEagerInit) {
  app = app.use(async (ctx) => {
    initOAuth(ctx.url);
    return await ctx.next();
  });
}

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

// ============================================================================
// Register routes
// ============================================================================

// OAuth routes (login, callback, metadata)
app = registerOAuthRoutes(app);

// Auth API routes (session, logout)
app = registerAuthRoutes(app);

// Bookmark API routes
app = registerBookmarkRoutes(app);

// Bulk operations API routes
app = registerBulkRoutes(app);

// Import API routes
app = registerImportRoutes(app);

// One-time migration: hex rkeys → TIDs
app = registerMigrateHexRkeysRoute(app);

// Tag API routes
app = registerTagRoutes(app);

// User-scoped API routes (supporter status)
app = registerUserRoutes(app);

// Initial data API route (combined bookmarks + tags + settings)
app = registerInitialDataRoutes(app);

// Settings API routes
app = registerSettingsRoutes(app);

// Preferences API routes (PDS-backed user preferences)
app = registerPreferencesRoutes(app);

// Share API routes (public bookmark sharing)
app = registerShareApiRoutes(app);

// Sync API routes (mirror tracking + TAP webhook).
// The /api/sync/hook ipFilter middleware is registered inside
// registerSyncRoutes so the route and its gate stay together.
app = registerSyncRoutes(app);

// Live event WebSocket route (server → SPA push).
app = registerLiveRoutes(app);

// System API routes (/api/version, /api/health) -- release observability
app = registerSystemRoutes(app);

// Frontend perf beacon endpoint (logs structured perf JSON line)
app = registerMetricsRoutes(app);

// RSS feed routes
app = registerRssRoutes(app);

// Share target routes (PWA share functionality)
app = registerShareTargetRoutes(app);

// Serve static files from /static directory (must be after API routes to
// prevent staticFiles() from intercepting POST/PUT/DELETE requests with 405)
app.use(staticFiles());

// Static files and SPA routing (must be last)
app = registerStaticRoutes(app, import.meta.url);

// Export app for Fresh build system
export { app };
