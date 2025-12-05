/**
 * Static file and SPA routes.
 * Handles static assets, robots.txt, and SPA fallback routing.
 */

import type { App } from "@fresh/core";
import { getBundleFileName, readFile, serveFile } from "../lib/file-server.ts";
import { decodeTagsFromUrl } from "../shared/utils.ts";

// Cache the bundle filename at startup (lazy loaded on first request)
let cachedBundleFileName: string | null = null;

/**
 * Get the HTML template with the correct hashed bundle filename injected.
 */
export async function getHtmlWithBundle(): Promise<string> {
  // Lazy load the bundle filename
  if (!cachedBundleFileName) {
    cachedBundleFileName = await getBundleFileName(import.meta.url);
  }

  let html = await readFile("/frontend/index.html", import.meta.url);

  // Replace the bundle reference with the hashed version
  html = html.replace(
    /src="\/static\/bundle\.js"/,
    `src="/static/${cachedBundleFileName}"`,
  );

  return html;
}

export function registerStaticRoutes(app: App<any>): App<any> {
  // robots.txt
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

  // Serve static files (frontend bundle)
  app = app.get("/static/*", (ctx) => {
    const path = new URL(ctx.req.url).pathname;
    return serveFile(path, import.meta.url);
  });

  // Serve frontend files
  app = app.get("/frontend/*", (ctx) => {
    const path = new URL(ctx.req.url).pathname;
    return serveFile(path, import.meta.url);
  });

  app = app.get("/shared/*", (ctx) => {
    const path = new URL(ctx.req.url).pathname;
    return serveFile(path, import.meta.url);
  });

  app = app.get("/lexicons/*", (ctx) => {
    const path = new URL(ctx.req.url).pathname;
    return serveFile(path, import.meta.url);
  });

  app = app.get("/.well-known/atproto/lexicons/*", (ctx) => {
    const path = new URL(ctx.req.url).pathname.replace(
      "/.well-known/atproto/lexicons",
      "/lexicons",
    );
    return serveFile(path, import.meta.url);
  });

  // Serve index.html for root
  app = app.get("/", async () => {
    const html = await getHtmlWithBundle();
    return new Response(html, {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  });

  // Catch-all for SPA routing (must be last)
  app = app.get("*", async (ctx) => {
    const path = new URL(ctx.req.url).pathname;

    // Don't catch API routes or static assets
    if (
      path.startsWith("/api") ||
      path.startsWith("/oauth") ||
      path.startsWith("/login")
    ) {
      return new Response("Not Found", { status: 404 });
    }

    // Handle share URLs with server-side meta tag injection
    if (path.startsWith("/share/")) {
      try {
        const pathParts = path.split("/").filter((p) => p);
        if (pathParts.length === 3 && pathParts[0] === "share") {
          const did = pathParts[1];
          const encodedTags = pathParts[2];
          const tags = decodeTagsFromUrl(encodedTags);

          const baseUrl = ctx.req.url.split("/share/")[0];
          const apiUrl = `${baseUrl}/api/share/${did}/${encodedTags}`;
          const response = await fetch(apiUrl);

          if (response.ok) {
            const data = await response.json();
            const { handle, bookmarks } = data;

            let html = await getHtmlWithBundle();

            const title = `${handle}'s Bookmarks Collection: ${
              tags.join(", ")
            }`;
            const description = bookmarks.length > 0
              ? `${bookmarks.length} bookmark${
                bookmarks.length === 1 ? "" : "s"
              } tagged with ${tags.join(", ")}`
              : `Bookmark collection tagged with ${tags.join(", ")}`;
            const url = ctx.req.url;

            const escapeHtml = (str: string) =>
              str.replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(
                />/g,
                "&gt;",
              );
            const titleEscaped = escapeHtml(title);
            const descriptionEscaped = escapeHtml(description);
            const urlEscaped = escapeHtml(url);

            html = html.replace(
              /<title>[\s\S]*?<\/title>/,
              `<title>${titleEscaped}</title>`,
            );
            html = html.replace(
              /property="og:title"\s+content="[^"]*"/,
              `property="og:title" content="${titleEscaped}"`,
            );
            html = html.replace(
              /name="twitter:title"\s+content="[^"]*"/,
              `name="twitter:title" content="${titleEscaped}"`,
            );
            html = html.replace(
              /name="description"\s+content="[^"]*"/,
              `name="description" content="${descriptionEscaped}"`,
            );
            html = html.replace(
              /property="og:description"\s+content="[^"]*"/,
              `property="og:description" content="${descriptionEscaped}"`,
            );
            html = html.replace(
              /name="twitter:description"\s+content="[^"]*"/,
              `name="twitter:description" content="${descriptionEscaped}"`,
            );
            html = html.replace(
              /property="og:url"\s+content="[^"]*"/,
              `property="og:url" content="${urlEscaped}"`,
            );
            html = html.replace(
              /name="twitter:url"\s+content="[^"]*"/,
              `name="twitter:url" content="${urlEscaped}"`,
            );

            const rssUrl = `${baseUrl}/share/${did}/${encodedTags}/rss`;
            const rssUrlEscaped = escapeHtml(rssUrl);
            const rssLink =
              `\n    <link rel="alternate" type="application/rss+xml" title="${titleEscaped}" href="${rssUrlEscaped}" />`;
            html = html.replace(/<\/head>/, `${rssLink}\n  </head>`);

            return new Response(html, {
              headers: { "Content-Type": "text/html; charset=utf-8" },
            });
          }
        }
      } catch (error) {
        console.error("Error generating share page meta tags:", error);
      }
    }

    // Default: serve base HTML for all other routes
    const html = await getHtmlWithBundle();
    return new Response(html, {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  });

  return app;
}
