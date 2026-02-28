/**
 * Minimal service worker for kipclip PWA
 *
 * This service worker provides:
 * - PWA installability requirements
 * - Share target handling
 *
 * It does NOT provide offline caching (by design - we want fresh data).
 */

const SW_VERSION = "1.0.0";

// Install event - take control immediately
self.addEventListener("install", (event) => {
  console.log("[SW] Installing service worker v" + SW_VERSION);
  self.skipWaiting();
});

// Activate event - claim all clients
self.addEventListener("activate", (event) => {
  console.log("[SW] Activating service worker v" + SW_VERSION);
  event.waitUntil(self.clients.claim());
});

// Fetch event - pass through to network (no caching)
self.addEventListener("fetch", (event) => {
  // Handle share target POST requests
  if (
    event.request.method === "POST" &&
    event.request.url.includes("/share-target")
  ) {
    event.respondWith(handleShareTarget(event.request));
    return;
  }

  // All other requests: pass through to network
  event.respondWith(fetch(event.request));
});

/**
 * Handle share target POST requests
 * Converts POST form data to GET request with query params
 */
async function handleShareTarget(request) {
  try {
    const formData = await request.formData();
    const title = formData.get("title") || "";
    const text = formData.get("text") || "";
    const url = formData.get("url") || "";

    // Build redirect URL with shared data as query params
    const redirectUrl = new URL("/", self.location.origin);
    redirectUrl.searchParams.set("action", "share");
    if (url) redirectUrl.searchParams.set("url", url);
    if (title) redirectUrl.searchParams.set("title", title);
    if (text) redirectUrl.searchParams.set("text", text);

    // Redirect to the app with the shared data
    return Response.redirect(redirectUrl.toString(), 303);
  } catch (error) {
    console.error("[SW] Share target error:", error);
    return Response.redirect("/", 303);
  }
}
