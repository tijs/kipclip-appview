/** @jsxImportSource https://esm.sh/react */
import { useState } from "https://esm.sh/react";

/**
 * Validate an AT Protocol handle format.
 * Valid formats:
 * - user.bsky.social
 * - example.com
 * - subdomain.example.com
 */
function validateHandle(handle: string): { valid: boolean; error?: string } {
  const trimmed = handle.trim();

  if (!trimmed) {
    return { valid: false, error: "Handle is required" };
  }

  // Handle must contain at least one dot
  if (!trimmed.includes(".")) {
    return {
      valid: false,
      error: "Handle must include a domain (e.g., alice.bsky.social)",
    };
  }

  // Basic format check: alphanumeric, dots, hyphens only
  const validPattern = /^[a-zA-Z0-9][a-zA-Z0-9.-]*[a-zA-Z0-9]$/;
  if (!validPattern.test(trimmed)) {
    return {
      valid: false,
      error: "Handle contains invalid characters",
    };
  }

  // Check for consecutive dots or dots at start/end (already handled by pattern above)
  if (trimmed.includes("..")) {
    return {
      valid: false,
      error: "Handle cannot contain consecutive dots",
    };
  }

  return { valid: true };
}

export function Login() {
  const [handle, setHandle] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (!handle.trim()) return;

    // Validate handle format
    const validation = validateHandle(handle);
    if (!validation.valid) {
      setError(validation.error || "Invalid handle format");
      return;
    }

    setLoading(true);
    try {
      // Preserve redirect parameter if present
      const params = new URLSearchParams(globalThis.location.search);
      const redirect = params.get("redirect");

      let loginUrl = `/login?handle=${encodeURIComponent(handle.trim())}`;
      if (redirect) {
        loginUrl += `&redirect=${encodeURIComponent(redirect)}`;
      }

      // Redirect to OAuth login
      globalThis.location.href = loginUrl;
    } catch (error) {
      console.error("Login failed:", error);
      setError("Login failed. Please try again.");
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center px-4">
      <div className="max-w-md w-full">
        <div className="text-center mb-8 fade-in">
          <img
            src="https://res.cloudinary.com/dru3aznlk/image/upload/v1760376452/kip-satchel-transparent_ewnh0j.png"
            alt="kipclip mascot - a friendly chicken with a bookmark bag"
            className="w-48 h-48 mx-auto mb-6 object-contain"
          />
          <h1
            className="text-4xl font-bold mb-2"
            style={{ color: "var(--coral)" }}
          >
            kipclip
          </h1>
          <p className="text-gray-600">
            You find it, you kip it
          </p>
        </div>

        <div className="card fade-in">
          <form onSubmit={handleLogin} className="space-y-4">
            <div>
              <label
                htmlFor="handle"
                className="block text-sm font-medium text-gray-700 mb-2"
              >
                Your Bluesky or AT Protocol handle
              </label>
              <input
                type="text"
                id="handle"
                value={handle}
                onChange={(e) => setHandle(e.target.value)}
                placeholder="alice.bsky.social or your-domain.com"
                className="w-full px-4 py-3 rounded-lg border border-gray-300 focus:ring-2 focus:ring-coral focus:border-transparent outline-none transition"
                disabled={loading}
                autoFocus
              />
            </div>

            {error && (
              <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg text-sm">
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={loading || !handle.trim()}
              className="btn-primary w-full disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {loading
                ? (
                  <span className="flex items-center justify-center gap-2">
                    <div className="spinner w-5 h-5 border-2"></div>
                    Connecting...
                  </span>
                )
                : (
                  "Sign in"
                )}
            </button>
          </form>

          <div className="mt-6 text-center text-sm text-gray-500 space-y-3">
            <p>
              kipclip works with your Bluesky account or any AT Protocol handle.
              Your bookmarks are saved to your own personal data server, so you
              own and control your data.{" "}
              <a
                href="/faq"
                className="underline hover:text-gray-700"
              >
                Learn more
              </a>
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
