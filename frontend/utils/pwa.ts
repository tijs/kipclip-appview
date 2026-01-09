/**
 * PWA detection and OAuth utilities
 */

/**
 * Check if the app is running as a standalone PWA (installed to home screen)
 */
export function isStandalonePwa(): boolean {
  // Check display-mode media query (works on Android Chrome)
  const displayModeStandalone = globalThis.matchMedia &&
    globalThis.matchMedia("(display-mode: standalone)").matches;
  // Check iOS standalone mode
  // deno-lint-ignore no-explicit-any
  const iosStandalone = (globalThis.navigator as any).standalone === true;
  // Check if launched from TWA (Trusted Web Activity on Android)
  const isTwa = document.referrer.includes("android-app://");

  console.log("[PWA] Detection checks:", {
    displayModeStandalone,
    iosStandalone,
    isTwa,
    referrer: document.referrer,
  });

  return displayModeStandalone || iosStandalone || isTwa;
}

/**
 * Open OAuth login in a popup window and wait for the result.
 * Uses both postMessage and localStorage to receive the result,
 * since window.opener can be lost after navigating through external OAuth providers.
 *
 * @param loginUrl The login URL with handle and pwa=true params
 * @returns Promise that resolves with session data or rejects on error/cancel
 */
export function openOAuthPopup(
  loginUrl: string,
): Promise<{ did: string; handle: string }> {
  console.log("[PWA OAuth] openOAuthPopup called with:", loginUrl);

  return new Promise((resolve, reject) => {
    console.log("[PWA OAuth] Inside promise, clearing previous result");
    // Clear any previous OAuth result
    localStorage.removeItem("pwa-oauth-result");

    // Calculate popup position (centered)
    const width = 500;
    const height = 600;
    const left = Math.max(0, (screen.width - width) / 2);
    const top = Math.max(0, (screen.height - height) / 2);

    // Open popup
    console.log("[PWA OAuth] Opening popup window...");
    const popup = globalThis.open(
      loginUrl,
      "oauth-popup",
      `width=${width},height=${height},left=${left},top=${top},menubar=no,toolbar=no,location=yes,status=no`,
    );

    console.log("[PWA OAuth] Popup result:", popup ? "opened" : "blocked");

    if (!popup) {
      reject(
        new Error("Could not open popup. Please allow popups for this site."),
      );
      return;
    }

    console.log("[PWA OAuth] Setting up event listeners and polling...");

    // Handle successful OAuth result
    function handleSuccess(data: { did: string; handle: string }) {
      console.log("[PWA OAuth] handleSuccess called with:", data);
      cleanup();
      localStorage.removeItem("pwa-oauth-result");
      console.log("[PWA OAuth] Resolving promise and triggering reload...");
      resolve(data);
    }

    // Listen for postMessage from popup (works if opener relationship preserved)
    function handleMessage(event: MessageEvent) {
      const data = event.data;
      if (data?.type === "oauth-callback" && data.success) {
        handleSuccess({ did: data.did, handle: data.handle });
      }
    }

    // Listen for localStorage changes (fallback when opener is lost)
    function handleStorage(event: StorageEvent) {
      if (event.key === "pwa-oauth-result" && event.newValue) {
        try {
          const data = JSON.parse(event.newValue);
          if (data?.type === "oauth-callback" && data.success) {
            handleSuccess({ did: data.did, handle: data.handle });
          }
        } catch {
          // Ignore parse errors
        }
      }
    }

    // Poll localStorage frequently - the storage event doesn't always fire reliably
    // especially after OAuth redirects through external providers
    console.log("[PWA OAuth] Starting localStorage polling...");
    let pollCount = 0;

    // Keep reference for cleanup
    let pollingStopped = false;

    function pollForResult() {
      if (pollingStopped) {
        console.log("[PWA OAuth] Polling stopped");
        return;
      }
      try {
        pollCount++;
        const result = localStorage.getItem("pwa-oauth-result");
        // Log every 5th poll (every 1 second) to show we're still running
        if (pollCount % 5 === 0) {
          console.log(
            "[PWA OAuth] Poll #" + pollCount + ", localStorage result:",
            result ? "FOUND" : "empty",
          );
        }
        if (result) {
          console.log("[PWA OAuth] Found result in localStorage:", result);
          const data = JSON.parse(result);
          console.log("[PWA OAuth] Parsed data:", data);
          if (data?.type === "oauth-callback" && data.success) {
            console.log("[PWA OAuth] Calling handleSuccess");
            handleSuccess({ did: data.did, handle: data.handle });
            return; // Stop polling
          }
        }
        // Schedule next poll
        setTimeout(pollForResult, 200);
      } catch (e) {
        console.error("[PWA OAuth] Poll error:", e);
        // Continue polling despite error
        if (!pollingStopped) {
          setTimeout(pollForResult, 200);
        }
      }
    }

    // Start polling immediately
    console.log("[PWA OAuth] Starting first poll now...");
    pollForResult();
    console.log("[PWA OAuth] First poll executed");

    // Don't rely on popup.closed - it returns true when popup navigates cross-origin
    // Instead, use a timeout. OAuth should complete within 5 minutes max.
    const OAUTH_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
    const startTime = Date.now();

    const checkTimeout = setInterval(() => {
      const elapsed = Date.now() - startTime;
      if (elapsed > OAUTH_TIMEOUT_MS) {
        console.log("[PWA OAuth] Timeout reached after 5 minutes");
        cleanup();
        reject(new Error("Login timed out"));
        clearInterval(checkTimeout);
      }
    }, 10000); // Check every 10 seconds

    function cleanup() {
      console.log("[PWA OAuth] Cleanup called");
      pollingStopped = true;
      globalThis.removeEventListener("message", handleMessage);
      globalThis.removeEventListener("storage", handleStorage);
      clearInterval(checkTimeout);
    }

    globalThis.addEventListener("message", handleMessage);
    globalThis.addEventListener("storage", handleStorage);
  });
}
