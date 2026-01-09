/**
 * PWA detection and OAuth utilities
 */

/**
 * Check if the app is running as a standalone PWA (installed to home screen)
 */
export function isStandalonePwa(): boolean {
  // Check display-mode media query (works on Android Chrome)
  if (
    globalThis.matchMedia &&
    globalThis.matchMedia("(display-mode: standalone)").matches
  ) {
    return true;
  }

  // Check iOS standalone mode
  // deno-lint-ignore no-explicit-any
  if ((globalThis.navigator as any).standalone === true) {
    return true;
  }

  // Check if launched from TWA (Trusted Web Activity on Android)
  if (document.referrer.includes("android-app://")) {
    return true;
  }

  return false;
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
  return new Promise((resolve, reject) => {
    // Clear any previous OAuth result
    localStorage.removeItem("pwa-oauth-result");

    // Calculate popup position (centered)
    const width = 500;
    const height = 600;
    const left = Math.max(0, (screen.width - width) / 2);
    const top = Math.max(0, (screen.height - height) / 2);

    // Open popup
    const popup = globalThis.open(
      loginUrl,
      "oauth-popup",
      `width=${width},height=${height},left=${left},top=${top},menubar=no,toolbar=no,location=yes,status=no`,
    );

    if (!popup) {
      reject(
        new Error("Could not open popup. Please allow popups for this site."),
      );
      return;
    }

    // Handle successful OAuth result
    function handleSuccess(data: { did: string; handle: string }) {
      cleanup();
      localStorage.removeItem("pwa-oauth-result");
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
    const pollLocalStorage = setInterval(() => {
      const result = localStorage.getItem("pwa-oauth-result");
      if (result) {
        try {
          const data = JSON.parse(result);
          if (data?.type === "oauth-callback" && data.success) {
            handleSuccess({ did: data.did, handle: data.handle });
            return;
          }
        } catch {
          // Ignore parse errors
        }
      }
    }, 200);

    // Check if popup was closed
    const checkClosed = setInterval(() => {
      if (popup.closed) {
        // Give a brief moment for any final localStorage write
        setTimeout(() => {
          const result = localStorage.getItem("pwa-oauth-result");
          if (result) {
            try {
              const data = JSON.parse(result);
              if (data?.type === "oauth-callback" && data.success) {
                handleSuccess({ did: data.did, handle: data.handle });
                return;
              }
            } catch {
              // Ignore parse errors
            }
          }
          cleanup();
          reject(new Error("Login cancelled"));
        }, 300);
        clearInterval(checkClosed); // Stop checking for closed
      }
    }, 500);

    function cleanup() {
      globalThis.removeEventListener("message", handleMessage);
      globalThis.removeEventListener("storage", handleStorage);
      clearInterval(pollLocalStorage);
      clearInterval(checkClosed);
    }

    globalThis.addEventListener("message", handleMessage);
    globalThis.addEventListener("storage", handleStorage);
  });
}
