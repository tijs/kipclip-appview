/** @jsxImportSource https://esm.sh/react */
import { useState } from "https://esm.sh/react";

export function Tools() {
  const [copied, setCopied] = useState(false);

  const bookmarkletCode =
    `javascript:(function(){window.open('https://kipclip.com/save?url='+encodeURIComponent(location.href),'kipclip','width=600,height=700')})()`;

  // Create bookmarklet HTML to bypass React's security check
  const bookmarkletHTML = `<a href="${
    bookmarkletCode.replace(/"/g, "&quot;")
  }" onclick="return false;" class="inline-flex items-center gap-2 px-6 py-3 rounded-lg font-bold text-white shadow-lg hover:shadow-xl transition-shadow cursor-move select-none" style="background-color: var(--coral)" draggable="true"><svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-3.5L5 21V5z"></path></svg> Kip it</a>`;

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(bookmarkletCode);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error("Failed to copy:", err);
    }
  }

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

      <main className="max-w-4xl mx-auto px-4 py-12">
        <div className="mb-8">
          <h2 className="text-3xl font-bold text-gray-800 mb-3">
            Save from Anywhere
          </h2>
          <p className="text-gray-600 text-lg">
            Add bookmarks to kipclip from any website with these tools
          </p>
        </div>

        {/* Bookmarklet Section */}
        <div className="bg-white rounded-lg shadow-md p-8 mb-8">
          <div className="flex items-start gap-3 mb-6">
            <div className="w-10 h-10 bg-coral/10 rounded-lg flex items-center justify-center flex-shrink-0">
              <svg
                className="w-6 h-6"
                style={{ color: "var(--coral)" }}
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M13 10V3L4 14h7v7l9-11h-7z"
                />
              </svg>
            </div>
            <div>
              <h3 className="text-xl font-bold text-gray-800 mb-2">
                Browser Bookmarklet
              </h3>
              <p className="text-gray-600">
                Works on all desktop browsers (Chrome, Firefox, Safari, Edge)
              </p>
            </div>
          </div>

          {/* Draggable Bookmarklet */}
          <div className="mb-6">
            <div className="bg-gray-50 border-2 border-dashed border-gray-300 rounded-lg p-6 text-center">
              <p className="text-sm text-gray-600 mb-4 font-medium">
                Drag this button to your bookmarks bar:
              </p>
              <div
                dangerouslySetInnerHTML={{ __html: bookmarkletHTML }}
              />
            </div>
          </div>

          {/* Instructions */}
          <div className="space-y-4 mb-6">
            <div>
              <h4 className="font-semibold text-gray-800 mb-2">
                How to install:
              </h4>
              <ol className="space-y-2 text-sm text-gray-700">
                <li className="flex items-start gap-2">
                  <span className="font-bold text-coral min-w-[20px]">1.</span>
                  <span>
                    Make sure your bookmarks bar is visible (press{" "}
                    <kbd className="px-2 py-1 bg-gray-200 rounded text-xs font-mono">
                      Cmd+Shift+B
                    </kbd>{" "}
                    or{" "}
                    <kbd className="px-2 py-1 bg-gray-200 rounded text-xs font-mono">
                      Ctrl+Shift+B
                    </kbd>)
                  </span>
                </li>
                <li className="flex items-start gap-2">
                  <span className="font-bold text-coral min-w-[20px]">2.</span>
                  <span>
                    Drag the "Kip it" button above to your bookmarks bar
                  </span>
                </li>
                <li className="flex items-start gap-2">
                  <span className="font-bold text-coral min-w-[20px]">3.</span>
                  <span>
                    When you're on a page you want to save, click the
                    bookmarklet in your bookmarks bar
                  </span>
                </li>
              </ol>
            </div>
          </div>

          {/* Alternative Methods */}
          <div className="border-t pt-6">
            <h4 className="font-semibold text-gray-800 mb-3">
              Alternative installation methods:
            </h4>
            <div className="space-y-3 text-sm">
              <div className="bg-gray-50 rounded-lg p-4">
                <p className="text-gray-700 mb-2">
                  <strong>Method 2:</strong>{" "}
                  Right-click the button above and select "Bookmark This Link"
                  or "Add to Bookmarks"
                </p>
              </div>
              <div className="bg-gray-50 rounded-lg p-4">
                <p className="text-gray-700 mb-3">
                  <strong>Method 3:</strong>{" "}
                  Copy the code and create a bookmark manually:
                </p>
                <div className="flex gap-2">
                  <code className="flex-1 bg-white px-3 py-2 rounded border text-xs overflow-x-auto">
                    {bookmarkletCode}
                  </code>
                  <button
                    type="button"
                    onClick={handleCopy}
                    className="px-4 py-2 bg-gray-800 text-white rounded hover:bg-gray-700 transition flex-shrink-0"
                  >
                    {copied ? "Copied!" : "Copy"}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Mobile Section */}
        <div className="bg-white rounded-lg shadow-md p-8">
          <div className="flex items-start gap-3 mb-6">
            <div className="w-10 h-10 bg-coral/10 rounded-lg flex items-center justify-center flex-shrink-0">
              <svg
                className="w-6 h-6"
                style={{ color: "var(--coral)" }}
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M12 18h.01M8 21h8a2 2 0 002-2V5a2 2 0 00-2-2H8a2 2 0 00-2 2v14a2 2 0 002 2z"
                />
              </svg>
            </div>
            <div>
              <h3 className="text-xl font-bold text-gray-800 mb-2">
                Mobile Devices
              </h3>
              <p className="text-gray-600">
                Save bookmarks from your phone or tablet
              </p>
            </div>
          </div>

          <div className="space-y-4">
            <div className="bg-gray-50 rounded-lg p-4">
              <h4 className="font-semibold text-gray-800 mb-2">
                iOS (Safari):
              </h4>
              <ol className="space-y-2 text-sm text-gray-700">
                <li className="flex items-start gap-2">
                  <span className="font-bold text-coral min-w-[20px]">1.</span>
                  <span>Open kipclip.com in Safari</span>
                </li>
                <li className="flex items-start gap-2">
                  <span className="font-bold text-coral min-w-[20px]">2.</span>
                  <span>
                    Tap the Share button, then "Add to Home Screen"
                  </span>
                </li>
                <li className="flex items-start gap-2">
                  <span className="font-bold text-coral min-w-[20px]">3.</span>
                  <span>
                    When sharing content from other apps, look for "kipclip" in
                    the share menu
                  </span>
                </li>
              </ol>
            </div>

            <div className="bg-gray-50 rounded-lg p-4">
              <h4 className="font-semibold text-gray-800 mb-2">
                Android (Chrome):
              </h4>
              <ol className="space-y-2 text-sm text-gray-700">
                <li className="flex items-start gap-2">
                  <span className="font-bold text-coral min-w-[20px]">1.</span>
                  <span>Open kipclip.com in Chrome</span>
                </li>
                <li className="flex items-start gap-2">
                  <span className="font-bold text-coral min-w-[20px]">2.</span>
                  <span>
                    Tap the menu (⋮), then "Add to Home screen"
                  </span>
                </li>
                <li className="flex items-start gap-2">
                  <span className="font-bold text-coral min-w-[20px]">3.</span>
                  <span>
                    When sharing URLs from other apps, kipclip will appear as a
                    share target
                  </span>
                </li>
              </ol>
            </div>
          </div>
        </div>

        {/* Help Section */}
        <div className="mt-8 text-center text-sm text-gray-600">
          <p>
            Need help?{" "}
            <a
              href="/"
              className="font-medium hover:underline"
              style={{ color: "var(--coral)" }}
            >
              Contact us
            </a>
          </p>
        </div>
      </main>
    </div>
  );
}
