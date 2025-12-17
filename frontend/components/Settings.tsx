import { useEffect, useState } from "react";
import { useApp } from "../context/AppContext.tsx";

export function Settings() {
  const { settings, updateSettings } = useApp();
  const [readingListTag, setReadingListTag] = useState(settings.readingListTag);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  // Sync local state when settings from context change
  useEffect(() => {
    setReadingListTag(settings.readingListTag);
  }, [settings.readingListTag]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSuccess(false);
    setSaving(true);

    try {
      await updateSettings({ readingListTag: readingListTag.trim() });
      setSuccess(true);
      setTimeout(() => setSuccess(false), 3000);
    } catch (err: any) {
      setError(err.message || "Failed to save settings");
    } finally {
      setSaving(false);
    }
  }

  const hasChanges = readingListTag.trim() !== settings.readingListTag;

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white shadow-sm">
        <div className="max-w-4xl mx-auto px-4 py-4 flex items-center justify-between">
          <a href="/" className="flex items-center gap-2">
            <img
              src="https://res.cloudinary.com/dru3aznlk/image/upload/v1760692589/kip-vignette_h2jwct.png"
              alt="Kip logo"
              className="w-8 h-8"
            />
            <h1
              className="text-2xl font-bold"
              style={{ color: "var(--coral)" }}
            >
              kipclip
            </h1>
          </a>
          <a
            href="/"
            className="text-gray-600 hover:text-gray-800 text-sm font-medium"
          >
            Back to Bookmarks
          </a>
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-4 py-12 space-y-8">
        <section>
          <h2 className="text-3xl font-bold text-gray-800 mb-3">
            Settings
          </h2>
          <p className="text-gray-700 text-lg">
            Customize how kipclip works for you.
          </p>
        </section>

        <form onSubmit={handleSubmit}>
          <section className="bg-white rounded-lg shadow-md p-6 space-y-6">
            <div>
              <h3 className="text-xl font-bold text-gray-800 mb-4">
                Reading List
              </h3>
              <p className="text-gray-600 mb-4">
                Your Reading List shows bookmarks with a specific tag. Use it to
                track articles you want to read later.
              </p>

              <div className="space-y-2">
                <label
                  htmlFor="readingListTag"
                  className="block text-sm font-medium text-gray-700"
                >
                  Reading List Tag
                </label>
                <input
                  type="text"
                  id="readingListTag"
                  value={readingListTag}
                  onChange={(e) => setReadingListTag(e.target.value)}
                  placeholder="toread"
                  className="w-full max-w-xs px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-coral/50 focus:border-coral"
                  style={{
                    "--tw-ring-color": "rgba(230, 100, 86, 0.5)",
                  } as any}
                />
                <p className="text-sm text-gray-500">
                  Bookmarks tagged with "{readingListTag || "toread"}" will
                  appear in your Reading List.
                </p>
              </div>
            </div>

            {error && (
              <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">
                {error}
              </div>
            )}

            {success && (
              <div className="p-3 bg-green-50 border border-green-200 rounded-lg text-green-700 text-sm">
                Settings saved successfully!
              </div>
            )}

            <div className="pt-4 border-t border-gray-200">
              <button
                type="submit"
                disabled={saving || !hasChanges}
                className="px-6 py-2 rounded-lg font-medium text-white transition-opacity disabled:opacity-50 disabled:cursor-not-allowed"
                style={{ backgroundColor: "var(--coral)" }}
              >
                {saving ? "Saving..." : "Save Settings"}
              </button>
            </div>
          </section>
        </form>
      </main>
    </div>
  );
}
