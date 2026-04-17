import { useEffect, useRef, useState } from "react";
import { isStandalonePwa, openOAuthPopup } from "../utils/pwa.ts";
import { Button } from "./Button.tsx";
import {
  getSavedIdentities,
  removeIdentity,
  type SavedIdentity,
  updateIdentityAvatar,
} from "../utils/saved-identities.ts";

/**
 * Hue from a handle — stable per-handle color for the initial-avatar fallback.
 * Keeps the saved-identity row visually distinct without shipping 1:1 avatars.
 */
function hueFromHandle(handle: string): number {
  let h = 0;
  for (let i = 0; i < handle.length; i++) {
    h = (h * 31 + handle.charCodeAt(i)) >>> 0;
  }
  return h % 360;
}

function IdentityAvatar(
  { handle, avatar, size = 40 }: {
    handle: string;
    avatar?: string;
    size?: number;
  },
) {
  const [failed, setFailed] = useState(false);
  const initial = handle.replace(/^@/, "").charAt(0).toUpperCase() || "?";
  const hue = hueFromHandle(handle);

  if (avatar && !failed) {
    return (
      <img
        src={avatar}
        alt=""
        width={size}
        height={size}
        className="rounded-full object-cover shrink-0"
        style={{ width: size, height: size }}
        onError={() => setFailed(true)}
      />
    );
  }

  return (
    <div
      className="rounded-full flex items-center justify-center font-semibold text-white shrink-0"
      style={{
        width: size,
        height: size,
        backgroundColor: `hsl(${hue}, 45%, 55%)`,
        fontSize: size * 0.4,
      }}
      aria-hidden
    >
      {initial}
    </div>
  );
}

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
  const [savedIdentities, setSavedIdentities] = useState<SavedIdentity[]>(
    getSavedIdentities,
  );
  const [showForm, setShowForm] = useState(savedIdentities.length === 0);

  // Sync handle state when the Web Component updates the input value
  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;

    // The actor-typeahead component sets input.value directly,
    // so we need to listen for input events to sync React state
    const handleInput = () => {
      setHandle(input.value);
    };

    // Ensure button state reflects any prefilled value when the form appears
    handleInput();

    input.addEventListener("input", handleInput);
    return () => input.removeEventListener("input", handleInput);
  }, [showForm]);

  // Fetch avatars for saved identities that don't have one cached yet.
  useEffect(() => {
    const missing = savedIdentities.filter((id) => !id.avatar);
    if (missing.length === 0) return;

    let cancelled = false;
    for (const identity of missing) {
      const url =
        `https://public.api.bsky.app/xrpc/app.bsky.actor.getProfile?actor=${
          encodeURIComponent(identity.handle)
        }`;
      fetch(url)
        .then((r) => r.ok ? r.json() : null)
        .then((data) => {
          if (cancelled || !data?.avatar) return;
          updateIdentityAvatar(identity.did, data.avatar);
          setSavedIdentities((current) =>
            current.map((id) =>
              id.did === identity.did ? { ...id, avatar: data.avatar } : id
            )
          );
        })
        .catch(() => {/* fallback to initial avatar */});
    }

    return () => {
      cancelled = true;
    };
  }, [savedIdentities.length]);

  async function startOAuthFlow(handle: string) {
    setLoading(true);
    try {
      const params = new URLSearchParams(globalThis.location.search);
      const redirect = params.get("redirect");

      let loginUrl = `/login?handle=${encodeURIComponent(handle)}`;
      if (redirect) {
        loginUrl += `&redirect=${encodeURIComponent(redirect)}`;
      }

      // PWA mode: use popup OAuth to avoid losing PWA context
      if (isStandalonePwa()) {
        loginUrl += "&pwa=true";
        try {
          await openOAuthPopup(loginUrl);
          globalThis.location.reload();
        } catch (popupError) {
          const message = popupError instanceof Error
            ? popupError.message
            : "Login failed";
          if (message !== "Login cancelled") {
            setError(message);
          }
          setLoading(false);
        }
        return;
      }

      // Regular web mode: redirect to OAuth login
      globalThis.location.href = loginUrl;
    } catch (_error) {
      console.error("Login failed:", _error);
      setError("Login failed. Please try again.");
      setLoading(false);
    }
  }

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    // Read directly from input in case Web Component updated it without firing input event
    const currentHandle = inputRef.current?.value || handle;
    if (!currentHandle.trim()) return;

    const trimmed = currentHandle.trim();

    // Authorization server URLs are valid for initiating OAuth flows
    if (!trimmed.startsWith("https://")) {
      const validation = validateHandle(trimmed);
      if (!validation.valid) {
        setError(validation.error || "Invalid handle format");
        return;
      }
    }

    await startOAuthFlow(trimmed);
  }

  function handleBlueskyConnect() {
    setError(null);
    startOAuthFlow("https://bsky.social");
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
          <h2 className="text-lg font-semibold text-gray-800 mb-4">
            Connect with your Atmosphere account
          </h2>

          {savedIdentities.length > 0 && !showForm && (
            <div className="space-y-3">
              {savedIdentities.map((identity) => (
                <div key={identity.did} className="relative group">
                  <button
                    type="button"
                    onClick={() => {
                      setError(null);
                      startOAuthFlow(identity.handle);
                    }}
                    disabled={loading}
                    className="w-full flex items-center gap-3 pl-3 pr-12 py-2.5 rounded-xl bg-white shadow-sm ring-1 ring-gray-200 hover:ring-2 hover:shadow-md hover:-translate-y-px transition-all text-left disabled:opacity-50 disabled:cursor-not-allowed"
                    style={{ transitionDuration: "150ms" }}
                  >
                    <IdentityAvatar
                      handle={identity.handle}
                      avatar={identity.avatar}
                    />
                    <div className="flex-1 min-w-0">
                      <div className="text-xs text-gray-500 leading-tight">
                        Continue as
                      </div>
                      <div className="font-semibold text-gray-800 truncate">
                        @{identity.handle}
                      </div>
                    </div>
                    <svg
                      className="w-5 h-5 text-gray-400 group-hover:text-gray-600 shrink-0"
                      fill="none"
                      viewBox="0 0 24 24"
                      strokeWidth={2}
                      stroke="currentColor"
                      aria-hidden
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        d="M9 5l7 7-7 7"
                      />
                    </svg>
                  </button>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      removeIdentity(identity.did);
                      setSavedIdentities((current) => {
                        const updated = current.filter((id) =>
                          id.did !== identity.did
                        );
                        if (updated.length === 0) {
                          setShowForm(true);
                        }
                        return updated;
                      });
                    }}
                    className="absolute -top-1.5 -right-1.5 w-6 h-6 flex items-center justify-center rounded-full bg-white shadow ring-1 ring-gray-200 text-gray-400 hover:text-gray-700 hover:ring-gray-300 transition opacity-0 group-hover:opacity-100 focus:opacity-100"
                    aria-label={`Remove ${identity.handle}`}
                  >
                    <svg
                      className="w-3.5 h-3.5"
                      fill="none"
                      viewBox="0 0 24 24"
                      strokeWidth={2.5}
                      stroke="currentColor"
                      aria-hidden
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        d="M6 18L18 6M6 6l12 12"
                      />
                    </svg>
                  </button>
                </div>
              ))}

              {error && (
                <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg text-sm">
                  {error}
                </div>
              )}

              {loading && (
                <div className="flex items-center justify-center gap-2 text-gray-500 py-2">
                  <div className="spinner w-5 h-5 border-2"></div>
                  Connecting...
                </div>
              )}

              <Button
                variant="link"
                size="sm"
                fullWidth
                onClick={() => setShowForm(true)}
              >
                Use a different account
              </Button>
            </div>
          )}

          {showForm && (
            <form onSubmit={handleLogin} className="space-y-4">
              <div>
                <label
                  htmlFor="handle"
                  className="block text-sm font-medium text-gray-700 mb-2"
                >
                  Handle
                </label>
                <actor-typeahead>
                  <input
                    ref={inputRef}
                    type="text"
                    id="handle"
                    autoComplete="off"
                    data-1p-ignore
                    data-lpignore="true"
                    data-form-type="other"
                    placeholder="alice.bsky.social or your-domain.com"
                    className="w-full px-4 py-3 rounded-lg border border-gray-300 focus:ring-2 focus:ring-coral focus:border-transparent outline-none transition"
                    disabled={loading}
                    autoFocus
                  />
                </actor-typeahead>
              </div>

              {error && (
                <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg text-sm">
                  {error}
                </div>
              )}

              <Button
                type="submit"
                variant="primary"
                fullWidth
                loading={loading}
                disabled={!handle.trim()}
              >
                {loading ? "Connecting..." : "Connect"}
              </Button>

              {savedIdentities.length > 0 && (
                <Button
                  variant="link"
                  size="sm"
                  fullWidth
                  onClick={() => setShowForm(false)}
                >
                  Back to saved accounts
                </Button>
              )}
            </form>
          )}

          <details className="mt-4 text-sm text-gray-500">
            <summary className="cursor-pointer font-medium text-gray-600 hover:text-gray-800">
              What is an Atmosphere account?
            </summary>
            <div className="mt-2 space-y-2">
              <p>
                The Atmosphere is an open ecosystem of apps built on AT Protocol
                — the same technology that powers Bluesky. When you create an
                Atmosphere account, it works automatically across a growing
                number of apps, including kipclip.
              </p>
              <p>
                Your bookmarks are yours — stored in your own account, not on
                our servers. If kipclip ever goes away, your data stays with
                you.{" "}
                <a href="/faq" className="underline hover:text-gray-700">
                  Learn more
                </a>
              </p>
            </div>
          </details>

          <Button
            href="/create-account"
            variant="secondary"
            fullWidth
            className="mt-4"
          >
            Create a new account
          </Button>

          <div className="relative my-6">
            <div className="absolute inset-0 flex items-center">
              <div className="w-full border-t border-gray-200"></div>
            </div>
            <div className="relative flex justify-center text-sm">
              <span className="px-3 bg-white text-gray-400">or</span>
            </div>
          </div>

          <Button
            variant="secondary"
            fullWidth
            onClick={handleBlueskyConnect}
            disabled={loading}
            leadingIcon={
              <svg
                className="w-5 h-5"
                viewBox="0 0 568 501"
                fill="#1185FF"
                aria-hidden
              >
                <path d="M123.121 33.6637C188.241 82.5526 258.281 181.681 284 234.873C309.719 181.681 379.759 82.5526 444.879 33.6637C491.866 -1.61183 568 -28.9064 568 57.9464C568 75.2916 558.055 203.659 552.222 224.501C531.947 296.954 458.067 315.434 392.347 304.249C507.222 323.8 536.444 388.56 473.333 453.32C353.473 576.312 301.061 422.461 287.631 383.039C285.169 375.812 284.017 372.431 284 375.306C283.983 372.431 282.831 375.812 280.369 383.039C266.939 422.461 214.527 576.312 94.6667 453.32C31.5556 388.56 60.7778 323.8 175.653 304.249C109.933 315.434 36.0533 296.954 15.7778 224.501C9.94525 203.659 0 75.2916 0 57.9464C0 -28.9064 76.1345 -1.61183 123.121 33.6637Z" />
              </svg>
            }
          >
            Connect with Bluesky
          </Button>
        </div>
      </div>
    </div>
  );
}
