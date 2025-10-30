import { Hono } from "https://esm.sh/hono";
import {
  readFile,
  serveFile,
} from "https://esm.town/v/std/utils@85-main/index.ts";
import { decodeTagsFromUrl } from "../../shared/utils.ts";

export const staticRoutes = new Hono();

// Serve frontend files
staticRoutes.get("/frontend/*", (c) => serveFile(c.req.path, import.meta.url));
staticRoutes.get("/shared/*", (c) => serveFile(c.req.path, import.meta.url));

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

  // Handle share URLs with server-side meta tag injection
  if (c.req.path.startsWith("/share/")) {
    try {
      const pathParts = c.req.path.split("/").filter((p) => p);
      if (pathParts.length === 3 && pathParts[0] === "share") {
        const did = pathParts[1];
        const encodedTags = pathParts[2];

        // Decode tags to use in meta tags
        const tags = decodeTagsFromUrl(encodedTags);

        // Fetch collection data from our own API
        const baseUrl = c.req.url.split("/share/")[0];
        const apiUrl = `${baseUrl}/api/share/${did}/${encodedTags}`;
        const response = await fetch(apiUrl);

        if (response.ok) {
          const data = await response.json();
          const { handle, bookmarks } = data;

          // Read base HTML
          let html = await readFile("/frontend/index.html", import.meta.url);

          // Create meta tag content
          const title = `${handle}'s Bookmarks Collection: ${tags.join(", ")}`;
          const description = bookmarks.length > 0
            ? `${bookmarks.length} bookmark${
              bookmarks.length === 1 ? "" : "s"
            } tagged with ${tags.join(", ")}`
            : `Bookmark collection tagged with ${tags.join(", ")}`;
          const url = c.req.url;

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

          console.log("Replaced meta tags for share URL:", {
            did,
            encodedTags,
            title,
            description,
            bookmarkCount: bookmarks.length,
          });

          return c.html(html);
        }
      }
    } catch (error) {
      // If anything fails, fall through to serve default HTML
      console.error("Error generating share page meta tags:", error);
    }
  }

  // Default: serve base HTML for all other routes
  const html = await readFile("/frontend/index.html", import.meta.url);
  return c.html(html);
});
