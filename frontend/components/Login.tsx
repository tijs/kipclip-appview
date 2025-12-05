/** @jsxImportSource https://esm.sh/react@19 */
import { useEffect, useRef, useState } from "https://esm.sh/react@19";

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
  const inputRef = useRef<HTMLInputElement>(null);

  // Sync handle state when the Web Component updates the input value
  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;

    // The actor-typeahead component sets input.value directly,
    // so we need to listen for input events to sync React state
    const handleInput = () => {
      setHandle(input.value);
    };

    input.addEventListener("input", handleInput);
    return () => input.removeEventListener("input", handleInput);
  }, []);

  function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    // Read directly from input in case Web Component updated it without firing input event
    const currentHandle = inputRef.current?.value || handle;

    if (!currentHandle.trim()) return;

    // Validate handle format
    const validation = validateHandle(currentHandle);
    if (!validation.valid) {
      setError(validation.error || "Invalid handle format");
      return;
    }

    setLoading(true);
    try {
      // Preserve redirect parameter if present
      const params = new URLSearchParams(globalThis.location.search);
      const redirect = params.get("redirect");

      let loginUrl = `/login?handle=${
        encodeURIComponent(currentHandle.trim())
      }`;
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
              {/* @ts-ignore - actor-typeahead is a custom element */}
              <actor-typeahead>
                <input
                  ref={inputRef}
                  type="text"
                  id="handle"
                  placeholder="alice.bsky.social or your-domain.com"
                  className="w-full px-4 py-3 rounded-lg border border-gray-300 focus:ring-2 focus:ring-coral focus:border-transparent outline-none transition"
                  disabled={loading}
                  autoFocus
                />
                {/* @ts-ignore - actor-typeahead is a custom element */}
              </actor-typeahead>
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
