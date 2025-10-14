import { Hono } from "https://esm.sh/hono";
import {
  readFile,
  serveFile,
} from "https://esm.town/v/std/utils@85-main/index.ts";

export const staticRoutes = new Hono();

// Serve frontend files
staticRoutes.get("/frontend/*", (c) => serveFile(c.req.path, import.meta.url));
staticRoutes.get("/shared/*", (c) => serveFile(c.req.path, import.meta.url));

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
