export function Support() {
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
            Support kipclip
          </h2>
          <p className="text-gray-700 text-lg">
            kipclip is free to use. Your support helps fund kipclip and other AT
            Protocol apps built by{" "}
            <a
              href="https://bsky.app/profile/tijs.org"
              target="_blank"
              rel="noopener noreferrer"
              className="underline hover:text-gray-800"
            >
              tijs.org
            </a>
            .
          </p>
        </section>

        <section className="bg-white rounded-lg shadow-md p-6 space-y-4">
          <h3 className="text-xl font-bold text-gray-800">
            Become a supporter
          </h3>
          <p className="text-gray-700">
            Supporter status is recorded on AT Protocol and will unlock extra
            features in the future.
          </p>
          <a
            href="https://atprotofans.com/support/did:plc:aq7owa5y7ndc2hzjz37wy7ma"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 px-5 py-3 rounded-lg font-medium text-white hover:opacity-95"
            style={{ backgroundColor: "var(--coral)" }}
          >
            <svg
              className="w-5 h-5"
              fill="currentColor"
              viewBox="0 0 24 24"
              aria-hidden
            >
              <path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z" />
            </svg>
            Support on atprotofans
          </a>
        </section>
      </main>
    </div>
  );
}
