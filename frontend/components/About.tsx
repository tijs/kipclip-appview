/** @jsxImportSource https://esm.sh/react */

export function About() {
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
            About kipclip
          </h2>
          <p className="text-gray-700 text-lg">
            kipclip is a simple, open bookmarks app for the AT Protocol. Save
            links you care about, organize them with tags, and browse them from
            any device.
          </p>
        </section>

        <section className="bg-white rounded-lg shadow-md p-6 space-y-3">
          <h3 className="text-xl font-bold text-gray-800">How it works</h3>
          <ul className="list-disc pl-5 text-gray-700 space-y-2">
            <li>
              Your bookmarks are saved as AT Protocol records in your own PDS
              (Personal Data Server) under your account.
            </li>
            <li>
              kipclip uses a community lexicon (schema) so other AT Protocol
              apps can read these records too.
            </li>
            <li>
              The app UI is a lightweight web client; the data lives with you in
              your PDS.
            </li>
          </ul>
        </section>

        <section className="bg-white rounded-lg shadow-md p-6 space-y-3">
          <h3 className="text-xl font-bold text-gray-800">
            Important note on privacy
          </h3>
          <p className="text-gray-700">
            AT Protocol records are public by default. That means bookmarks you
            save with kipclip are public and discoverable. Please don’t save
            anything sensitive or private.
          </p>
        </section>

        <section className="bg-white rounded-lg shadow-md p-6">
          <h3 className="text-xl font-bold text-gray-800 mb-4">Links</h3>
          <div className="flex flex-col sm:flex-row gap-3">
            <a
              href="https://github.com/tijs/kipclip-appview"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg font-medium text-white hover:opacity-95"
              style={{ backgroundColor: "var(--coral)" }}
            >
              <svg
                className="w-5 h-5"
                viewBox="0 0 24 24"
                fill="currentColor"
                aria-hidden
              >
                <path d="M12 .5C5.73.5.94 5.29.94 11.56c0 4.86 3.15 8.98 7.52 10.43.55.1.75-.24.75-.53 0-.26-.01-1.12-.02-2.03-3.06.67-3.71-1.3-3.71-1.3-.5-1.28-1.23-1.63-1.23-1.63-1.01-.69.08-.68.08-.68 1.12.08 1.71 1.15 1.71 1.15.99 1.7 2.6 1.21 3.23.93.1-.72.39-1.21.71-1.49-2.44-.28-5-1.22-5-5.43 0-1.2.43-2.18 1.14-2.95-.11-.28-.5-1.43.11-2.98 0 0 .94-.3 3.07 1.13.89-.25 1.85-.37 2.81-.37.95 0 1.92.12 2.81.37 2.12-1.43 3.06-1.13 3.06-1.13.62 1.55.23 2.7.12 2.98.71.77 1.14 1.75 1.14 2.95 0 4.22-2.57 5.15-5.01 5.42.4.35.76 1.04.76 2.1 0 1.52-.01 2.74-.01 3.12 0 .29.2.64.76.53 4.36-1.45 7.51-5.57 7.51-10.43C23.06 5.29 18.27.5 12 .5z" />
              </svg>
              GitHub Repository
            </a>
            <a
              href="https://bsky.app/profile/tijs.org"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg font-medium text-white hover:opacity-95"
              style={{ backgroundColor: "#1185FF" }}
            >
              <span aria-hidden className="text-lg">🦋</span>
              made bij tijs.org
            </a>
          </div>
        </section>
      </main>
    </div>
  );
}
