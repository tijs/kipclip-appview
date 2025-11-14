/** @jsxImportSource https://esm.sh/react */
import { useEffect, useState } from "https://esm.sh/react";

export function Save() {
  const [session, setSession] = useState<
    { did: string; handle: string } | null
  >(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [url, setUrl] = useState("");

  useEffect(() => {
    // Get URL from query params
    const params = new URLSearchParams(globalThis.location.search);
    const urlParam = params.get("url");
    if (urlParam) {
      setUrl(urlParam);
    }

    // Check session
    checkSession();
  }, []);

  async function checkSession() {
    try {
      const response = await fetch("/api/auth/session", {
        credentials: "include",
      });
      if (response.ok) {
        const data = await response.json();
        setSession({
          did: data.did,
          handle: data.handle,
        });
      }
    } catch (error) {
      console.error("Failed to check session:", error);
    } finally {
      setLoading(false);
    }
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    if (!url.trim()) return;

    setSaving(true);
    setError(null);

    try {
      const response = await fetch("/api/bookmarks", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        credentials: "include",
        body: JSON.stringify({ url: url.trim() }),
      });

      // If session expired, redirect to login with current page
      if (response.status === 401) {
        const loginUrl = `/login?redirect=${
          encodeURIComponent(
            globalThis.location.pathname + globalThis.location.search,
          )
        }`;
        globalThis.location.href = loginUrl;
        return;
      }

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || "Failed to add bookmark");
      }

      setSaved(true);
    } catch (err: any) {
      setError(err.message);
      setSaving(false);
    }
  }

  function handleClose() {
    globalThis.close();
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-gray-50">
        <div className="spinner"></div>
      </div>
    );
  }

  if (!session) {
    const loginUrl = `/?redirect=${
      encodeURIComponent(
        globalThis.location.pathname + globalThis.location.search,
      )
    }`;
    return (
      <div className="flex items-center justify-center min-h-screen bg-gray-50 p-4">
        <div className="bg-white rounded-lg max-w-md w-full p-8 shadow-lg text-center">
          <div className="mb-6">
            <img
              src="https://res.cloudinary.com/dru3aznlk/image/upload/v1760692589/kip-vignette_h2jwct.png"
              alt="Kip logo"
              className="w-16 h-16 mx-auto mb-4"
            />
            <h1 className="text-2xl font-bold text-gray-800 mb-2">
              Login Required
            </h1>
            <p className="text-gray-600">
              Sign in to save bookmarks to kipclip
            </p>
          </div>

          <a
            href={loginUrl}
            className="inline-block w-full btn-primary py-3 px-4 rounded-lg text-center"
          >
            Sign in
          </a>
        </div>
      </div>
    );
  }

  if (saved) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-gray-50 p-4">
        <div className="bg-white rounded-lg max-w-md w-full p-8 shadow-lg text-center">
          <div className="mb-6">
            <div className="w-16 h-16 bg-green-100 rounded-full flex items-center justify-center mx-auto mb-4">
              <svg
                className="w-8 h-8 text-green-600"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M5 13l4 4L19 7"
                />
              </svg>
            </div>
            <h2 className="text-2xl font-bold text-gray-800 mb-2">
              Bookmark Saved!
            </h2>
            <p className="text-gray-600 mb-6">
              Your bookmark has been saved to kipclip
            </p>
          </div>

          <div className="space-y-3">
            <button
              type="button"
              onClick={handleClose}
              className="w-full px-4 py-3 rounded-lg border border-gray-300 text-gray-700 font-medium hover:bg-gray-50 transition"
            >
              Close Window
            </button>
            <a
              href="/"
              className="block w-full px-4 py-3 rounded-lg btn-primary text-center"
            >
              View All Bookmarks
            </a>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-center justify-center min-h-screen bg-gray-50 p-4">
      <div className="bg-white rounded-lg max-w-md w-full p-6 shadow-lg">
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-2">
            <img
              src="https://res.cloudinary.com/dru3aznlk/image/upload/v1760692589/kip-vignette_h2jwct.png"
              alt="Kip logo"
              className="w-8 h-8"
            />
            <h2 className="text-xl font-bold text-gray-800">Save Bookmark</h2>
          </div>
          <button
            type="button"
            onClick={handleClose}
            className="text-gray-400 hover:text-gray-600 text-2xl"
            disabled={saving}
          >
            ×
          </button>
        </div>

        <div className="mb-4 text-sm text-gray-600">
          Signed in as <span className="font-medium">@{session.handle}</span>
        </div>

        <form onSubmit={handleSave} className="space-y-4">
          <div>
            <label
              htmlFor="url"
              className="block text-sm font-medium text-gray-700 mb-2"
            >
              URL
            </label>
            <input
              type="url"
              id="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://example.com"
              className="w-full px-4 py-3 rounded-lg border border-gray-300 focus:ring-2 focus:ring-coral focus:border-transparent outline-none transition"
              disabled={saving}
              autoFocus
              required
            />
          </div>

          {error && (
            <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg text-sm">
              {error}
            </div>
          )}

          <button
            type="submit"
            className="w-full btn-primary py-3 disabled:opacity-50"
            disabled={saving || !url.trim()}
          >
            {saving
              ? (
                <span className="flex items-center justify-center gap-2">
                  <div className="spinner w-5 h-5 border-2"></div>
                  Saving...
                </span>
              )
              : (
                "Save Bookmark"
              )}
          </button>
        </form>

        <p className="text-xs text-gray-500 mt-4 text-center">
          The page title and description will be automatically fetched
        </p>
      </div>
    </div>
  );
}
