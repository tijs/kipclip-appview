/** @jsxImportSource https://esm.sh/react@19 */
import { useState } from "react";
import type { EnrichedBookmark } from "../../shared/types.ts";

interface AddBookmarkProps {
  onClose: () => void;
  onBookmarkAdded: (bookmark: EnrichedBookmark) => void;
}

export function AddBookmark({ onClose, onBookmarkAdded }: AddBookmarkProps) {
  const [url, setUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!url.trim()) return;

    setLoading(true);
    setError(null);

    try {
      const response = await fetch("/api/bookmarks", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ url: url.trim() }),
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || "Failed to add bookmark");
      }

      const data = await response.json();
      onBookmarkAdded(data.bookmark);
    } catch (err: any) {
      setError(err.message);
      setLoading(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
      <div className="bg-white rounded-lg max-w-md w-full p-6 fade-in">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-xl font-bold text-gray-800">Add Bookmark</h3>
          <button
            type="button"
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 text-2xl"
            disabled={loading}
          >
            ×
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
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
              disabled={loading}
              autoFocus
              required
            />
          </div>

          {error && (
            <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg text-sm">
              {error}
            </div>
          )}

          <div className="flex gap-3">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 px-4 py-3 rounded-lg border border-gray-300 text-gray-700 font-medium hover:bg-gray-50 transition"
              disabled={loading}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="flex-1 btn-primary disabled:opacity-50"
              disabled={loading || !url.trim()}
            >
              {loading
                ? (
                  <span className="flex items-center justify-center gap-2">
                    <div className="spinner w-5 h-5 border-2"></div>
                    Adding...
                  </span>
                )
                : (
                  "Add Bookmark"
                )}
            </button>
          </div>
        </form>

        <p className="text-xs text-gray-500 mt-4 text-center">
          The page title will be automatically fetched and saved with your
          bookmark
        </p>
      </div>
    </div>
  );
}
