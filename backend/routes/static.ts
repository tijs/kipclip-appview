import { Hono } from "https://esm.sh/hono";
import {
  readFile,
  serveFile,
} from "https://esm.town/v/std/utils@85-main/index.ts";

export const staticRoutes = new Hono();

// Serve frontend files
staticRoutes.get("/frontend/*", (c) => serveFile(c.req.path, import.meta.url));
staticRoutes.get("/shared/*", (c) => serveFile(c.req.path, import.meta.url));

// Serve manifest.json at root for PWA
staticRoutes.get(
  "/manifest.json",
  (_c) => serveFile("/frontend/manifest.json", import.meta.url),
);

// Serve lexicon files
staticRoutes.get("/lexicons/*", (c) => serveFile(c.req.path, import.meta.url));

// Serve lexicon at well-known location for AT Protocol discovery
staticRoutes.get("/.well-known/atproto/lexicons/*", (c) => {
  // Map /.well-known/atproto/lexicons/com/kipclip/tag.json to /lexicons/com/kipclip/tag.json
  const path = c.req.path.replace("/.well-known/atproto/lexicons", "/lexicons");
  return serveFile(path, import.meta.url);
});

// Serve index.html for root and SPA routes
staticRoutes.get("/", async (c) => {
  const html = await readFile("/frontend/index.html", import.meta.url);
  return c.html(html);
});

// Catch-all for SPA routing
staticRoutes.get("*", async (c) => {
  // Don't catch API routes or static assets
  if (
    c.req.path.startsWith("/api") || c.req.path.startsWith("/oauth") ||
    c.req.path.startsWith("/login")
  ) {
    return c.notFound();
  }

  const html = await readFile("/frontend/index.html", import.meta.url);
  return c.html(html);
});
