/** @jsxImportSource https://esm.sh/react */
import { useState } from "https://esm.sh/react";

export function Login() {
  const [handle, setHandle] = useState("");
  const [loading, setLoading] = useState(false);

  function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    if (!handle.trim()) return;

    setLoading(true);
    try {
      // Preserve redirect parameter if present
      const params = new URLSearchParams(globalThis.location.search);
      const redirect = params.get("redirect");

      let loginUrl = `/login?handle=${encodeURIComponent(handle)}`;
      if (redirect) {
        loginUrl += `&redirect=${encodeURIComponent(redirect)}`;
      }

      // Redirect to OAuth login
      globalThis.location.href = loginUrl;
    } catch (error) {
      console.error("Login failed:", error);
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
                Your AT Protocol handle
              </label>
              <input
                type="text"
                id="handle"
                value={handle}
                onChange={(e) => setHandle(e.target.value)}
                placeholder="alice.bsky.social"
                className="w-full px-4 py-3 rounded-lg border border-gray-300 focus:ring-2 focus:ring-coral focus:border-transparent outline-none transition"
                disabled={loading}
                autoFocus
              />
            </div>

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
                  "Sign in with AT Protocol"
                )}
            </button>
          </form>

          <div className="mt-6 text-center text-sm text-gray-500">
            <p>
              kipclip saves bookmarks to your personal data server using the
              {" "}
              <a
                href="https://github.com/lexicon-community/lexicon/blob/main/community/lexicon/bookmarks/bookmark.json"
                target="_blank"
                rel="noopener noreferrer"
                className="underline hover:text-gray-700"
              >
                community bookmark lexicon
              </a>
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
