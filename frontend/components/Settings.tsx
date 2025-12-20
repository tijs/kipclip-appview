import { useEffect, useState } from "react";
import { useApp } from "../context/AppContext.tsx";

export function Settings() {
  const { settings, updateSettings } = useApp();
  const [readingListTag, setReadingListTag] = useState(settings.readingListTag);
  const [instapaperEnabled, setInstapaperEnabled] = useState(
    settings.instapaperEnabled,
  );
  const [instapaperUsername, setInstapaperUsername] = useState(
    settings.instapaperUsername || "",
  );
  const [instapaperPassword, setInstapaperPassword] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  // Sync local state when settings from context change
  useEffect(() => {
    setReadingListTag(settings.readingListTag);
    setInstapaperEnabled(settings.instapaperEnabled);
    setInstapaperUsername(settings.instapaperUsername || "");
  }, [
    settings.readingListTag,
    settings.instapaperEnabled,
    settings.instapaperUsername,
  ]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSuccess(false);
    setSaving(true);

    try {
      const updates: any = {
        readingListTag: readingListTag.trim(),
        instapaperEnabled,
      };

      // Only send credentials if Instapaper is enabled
      if (instapaperEnabled) {
        // Always include username if enabled
        updates.instapaperUsername = instapaperUsername.trim();

        // Only include password if changed (not empty)
        if (instapaperPassword.trim().length > 0) {
          updates.instapaperPassword = instapaperPassword;
        }
      }

      await updateSettings(updates);
      setSuccess(true);
      setInstapaperPassword(""); // Clear password field after save
      setTimeout(() => setSuccess(false), 3000);
    } catch (err: any) {
      setError(err.message || "Failed to save settings");
    } finally {
      setSaving(false);
    }
  }

  const hasChanges = readingListTag.trim() !== settings.readingListTag ||
    instapaperEnabled !== settings.instapaperEnabled ||
    (instapaperEnabled &&
      instapaperUsername.trim() !== (settings.instapaperUsername || "")) ||
    instapaperPassword.trim().length > 0;

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
          </section>

          {/* Instapaper Integration Section */}
          <section className="bg-white rounded-lg shadow-md p-6 space-y-6">
            <div>
              <h3 className="text-xl font-bold text-gray-800 mb-4">
                Instapaper Integration
              </h3>
              <p className="text-gray-600 mb-4">
                Automatically send articles to Instapaper when you tag them with
                your reading list tag ("{readingListTag || "toread"}").
              </p>

              {/* Enable toggle */}
              <div className="flex items-center space-x-3 mb-4">
                <input
                  type="checkbox"
                  id="instapaperEnabled"
                  checked={instapaperEnabled}
                  onChange={(e) => setInstapaperEnabled(e.target.checked)}
                  className="w-4 h-4 rounded border-gray-300 text-coral focus:ring-coral"
                />
                <label
                  htmlFor="instapaperEnabled"
                  className="text-sm font-medium text-gray-700"
                >
                  Send articles to Instapaper
                </label>
              </div>

              {/* Credentials (shown when enabled) */}
              {instapaperEnabled && (
                <div className="space-y-4 pl-7">
                  <div className="space-y-2">
                    <label
                      htmlFor="instapaperUsername"
                      className="block text-sm font-medium text-gray-700"
                    >
                      Instapaper Email/Username
                    </label>
                    <input
                      type="text"
                      id="instapaperUsername"
                      value={instapaperUsername}
                      onChange={(e) => setInstapaperUsername(e.target.value)}
                      placeholder="your@email.com"
                      className="w-full max-w-md px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-coral/50 focus:border-coral"
                      required={instapaperEnabled}
                    />
                  </div>

                  <div className="space-y-2">
                    <label
                      htmlFor="instapaperPassword"
                      className="block text-sm font-medium text-gray-700"
                    >
                      Instapaper Password
                    </label>
                    <input
                      type="password"
                      id="instapaperPassword"
                      value={instapaperPassword}
                      onChange={(e) => setInstapaperPassword(e.target.value)}
                      placeholder={settings.instapaperUsername
                        ? "Leave blank to keep current password"
                        : "Enter password"}
                      className="w-full max-w-md px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-coral/50 focus:border-coral"
                      required={instapaperEnabled &&
                        !settings.instapaperUsername}
                    />
                    <p className="text-xs text-gray-500">
                      {settings.instapaperUsername
                        ? "Leave blank to keep your current password"
                        : "Your password is encrypted and stored securely"}
                    </p>
                  </div>

                  <div className="p-3 bg-blue-50 border border-blue-200 rounded-lg">
                    <p className="text-sm text-blue-800">
                      When you tag a bookmark with "{readingListTag || "toread"}
                      ", it will be automatically sent to your Instapaper
                      account.
                    </p>
                  </div>
                </div>
              )}
            </div>
          </section>

          {error && (
            <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">
              {error}
            </div>
          )}

          {success && (
            <div className="p-4 bg-green-50 border border-green-200 rounded-lg">
              <div className="flex items-start gap-3">
                <svg
                  className="w-5 h-5 text-green-600 flex-shrink-0 mt-0.5"
                  fill="currentColor"
                  viewBox="0 0 20 20"
                >
                  <path
                    fillRule="evenodd"
                    d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z"
                    clipRule="evenodd"
                  />
                </svg>
                <div className="flex-1">
                  <p className="text-sm font-medium text-green-800">
                    Settings saved successfully!
                  </p>
                  {instapaperEnabled && (
                    <p className="text-sm text-green-700 mt-1">
                      ✓ Instapaper connection verified - your articles will be
                      sent automatically
                    </p>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* Save Button */}
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
        </form>
      </main>
    </div>
  );
}
