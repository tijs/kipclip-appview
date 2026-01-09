/**
 * Share target route handler for PWA share functionality.
 * This is a fallback for when the service worker doesn't intercept the request.
 */

import type { App } from "@fresh/core";

/**
 * Create a redirect response with mutable headers.
 * Response.redirect() creates immutable headers which conflicts with
 * the security headers middleware.
 */
function redirect(location: string, status = 303): Response {
  return new Response(null, {
    status,
    headers: { Location: location },
  });
}

// deno-lint-ignore no-explicit-any
export function registerShareTargetRoutes(app: App<any>): App<any> {
  // Handle share target POST requests
  app = app.post("/share-target", async (ctx) => {
    try {
      const formData = await ctx.req.formData();
      const url = formData.get("url");
      const title = formData.get("title");
      const text = formData.get("text");

      // If we have a URL, redirect to the save page
      if (url && typeof url === "string") {
        const saveUrl = new URL("/save", new URL(ctx.req.url).origin);
        saveUrl.searchParams.set("url", url);
        if (title && typeof title === "string") {
          saveUrl.searchParams.set("title", title);
        }
        if (text && typeof text === "string") {
          saveUrl.searchParams.set("text", text);
        }
        return redirect(saveUrl.toString());
      }

      // If no URL, try to extract from text (some apps put URL in text field)
      if (text && typeof text === "string") {
        const urlMatch = text.match(/https?:\/\/[^\s]+/);
        if (urlMatch) {
          const saveUrl = new URL("/save", new URL(ctx.req.url).origin);
          saveUrl.searchParams.set("url", urlMatch[0]);
          return redirect(saveUrl.toString());
        }
      }

      // Fallback: redirect to home
      return redirect("/");
    } catch (error) {
      console.error("Share target error:", error);
      return redirect("/");
    }
  });

  return app;
}
