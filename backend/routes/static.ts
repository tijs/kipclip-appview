import type { App } from "jsr:@fresh/core@^2.2.0";

// Fresh App with any state type (we don't use Fresh's state management)
type FreshApp = App<any>;
import { decodeTagsFromUrl } from "../../shared/utils.ts";

// Use Val.Town's utilities in production, our esbuild version locally
const isProduction = Deno.env.get("ENVIRONMENT") === "PRODUCTION";

let readFile: (path: string, baseUrl: string) => Promise<string>;
let serveFile: (path: string, baseUrl: string) => Promise<Response>;

if (isProduction) {
  // Use Val.Town's native utilities (already handle TS transpilation)
  const utils = await import("https://esm.town/v/std/utils@85-main/index.ts");
  readFile = utils.readFile;
  serveFile = utils.serveFile;
  console.log("Using Val.Town utilities (production)");
} else {
  // Use local esbuild-based transpilation
  const localUtils = await import("../utils/file-server.ts");
  readFile = localUtils.readFile;
  serveFile = localUtils.serveFile;
  console.log("Using local esbuild utilities (development)");
}

/**
 * Register static file routes on the Fresh app
 */
export function registerStaticRoutes(app: FreshApp): FreshApp {
  // Serve frontend files
  app = app.get("/frontend/*", (ctx) => {
    const path = new URL(ctx.req.url).pathname;
    return serveFile(path, import.meta.url);
  });

  app = app.get("/shared/*", (ctx) => {
    const path = new URL(ctx.req.url).pathname;
    return serveFile(path, import.meta.url);
  });

  // Serve lexicon files
  app = app.get("/lexicons/*", (ctx) => {
    const path = new URL(ctx.req.url).pathname;
    return serveFile(path, import.meta.url);
  });

  // Serve lexicon at well-known location for AT Protocol discovery
  app = app.get("/.well-known/atproto/lexicons/*", (ctx) => {
    // Map /.well-known/atproto/lexicons/com/kipclip/tag.json to /lexicons/com/kipclip/tag.json
    const path = new URL(ctx.req.url).pathname.replace(
      "/.well-known/atproto/lexicons",
      "/lexicons",
    );
    return serveFile(path, import.meta.url);
  });

  // Serve index.html for root
  app = app.get("/", async () => {
    const html = await readFile("/frontend/index.html", import.meta.url);
    return new Response(html, {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  });

  // Catch-all for SPA routing (must be last)
  app = app.get("*", async (ctx) => {
    const path = new URL(ctx.req.url).pathname;

    // Don't catch API routes or static assets
    if (
      path.startsWith("/api") || path.startsWith("/oauth") ||
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

          // Decode tags to use in meta tags
          const tags = decodeTagsFromUrl(encodedTags);

          // Fetch collection data from our own API
          const baseUrl = ctx.req.url.split("/share/")[0];
          const apiUrl = `${baseUrl}/api/share/${did}/${encodedTags}`;
          const response = await fetch(apiUrl);

          if (response.ok) {
            const data = await response.json();
            const { handle, bookmarks } = data;

            // Read base HTML
            let html = await readFile("/frontend/index.html", import.meta.url);

            // Create meta tag content
            const title = `${handle}'s Bookmarks Collection: ${
              tags.join(", ")
            }`;
            const description = bookmarks.length > 0
              ? `${bookmarks.length} bookmark${
                bookmarks.length === 1 ? "" : "s"
              } tagged with ${tags.join(", ")}`
              : `Bookmark collection tagged with ${tags.join(", ")}`;
            const url = ctx.req.url;

            // Escape special characters for HTML attributes
            const escapeHtml = (str: string) =>
              str.replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(
                />/g,
                "&gt;",
              );
            const titleEscaped = escapeHtml(title);
            const descriptionEscaped = escapeHtml(description);
            const urlEscaped = escapeHtml(url);

            // Replace meta tag content with collection-specific values
            // Use multiline regex to handle formatting across lines
            // Title tags
            html = html.replace(
              /<title>[\s\S]*?<\/title>/,
              `<title>${titleEscaped}</title>`,
            );
            html = html.replace(
              /property="og:title"\s+content="[^"]*"/,
              `property="og:title"\n      content="${titleEscaped}"`,
            );
            html = html.replace(
              /name="twitter:title"\s+content="[^"]*"/,
              `name="twitter:title"\n      content="${titleEscaped}"`,
            );

            // Description tags
            html = html.replace(
              /name="description"\s+content="[^"]*"/,
              `name="description"\n      content="${descriptionEscaped}"`,
            );
            html = html.replace(
              /property="og:description"\s+content="[^"]*"/,
              `property="og:description"\n      content="${descriptionEscaped}"`,
            );
            html = html.replace(
              /name="twitter:description"\s+content="[^"]*"/,
              `name="twitter:description"\n      content="${descriptionEscaped}"`,
            );

            // URL tags
            html = html.replace(
              /property="og:url"\s+content="[^"]*"/,
              `property="og:url" content="${urlEscaped}"`,
            );
            html = html.replace(
              /name="twitter:url"\s+content="[^"]*"/,
              `name="twitter:url" content="${urlEscaped}"`,
            );

            // Add RSS auto-discovery link
            const rssUrl = `${baseUrl}/share/${did}/${encodedTags}/rss`;
            const rssUrlEscaped = escapeHtml(rssUrl);
            const rssLink =
              `\n    <link rel="alternate" type="application/rss+xml" title="${titleEscaped}" href="${rssUrlEscaped}" />`;

            // Insert RSS link before closing </head> tag
            html = html.replace(
              /<\/head>/,
              `${rssLink}\n  </head>`,
            );

            console.log("Replaced meta tags for share URL:", {
              did,
              encodedTags,
              title,
              description,
              bookmarkCount: bookmarks.length,
            });

            return new Response(html, {
              headers: { "Content-Type": "text/html; charset=utf-8" },
            });
          }
        }
      } catch (error) {
        // If anything fails, fall through to serve default HTML
        console.error("Error generating share page meta tags:", error);
      }
    }

    // Default: serve base HTML for all other routes
    const html = await readFile("/frontend/index.html", import.meta.url);
    return new Response(html, {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  });

  return app;
}
