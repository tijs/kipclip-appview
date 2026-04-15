import { PageShell } from "./PageShell.tsx";

export function Support() {
  return (
    <PageShell>
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

      <section className="bg-white rounded-lg shadow-md p-6 space-y-4">
        <h3 className="text-xl font-bold text-gray-800">
          How it works
        </h3>
        <div className="space-y-4">
          <div className="flex gap-4">
            <div
              className="flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center text-white text-sm font-bold"
              style={{ backgroundColor: "var(--coral)" }}
            >
              1
            </div>
            <div>
              <p className="font-medium text-gray-800">
                Click "Support on atprotofans"
              </p>
              <p className="text-gray-600 text-sm mt-1">
                You'll be taken to{" "}
                <a
                  href="https://atprotofans.com"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline hover:text-gray-800"
                >
                  atprotofans.com
                </a>
                , a support service built on AT Protocol. Sign in with your
                Bluesky account and choose an amount.
              </p>
            </div>
          </div>

          <div className="flex gap-4">
            <div
              className="flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center text-white text-sm font-bold"
              style={{ backgroundColor: "var(--coral)" }}
            >
              2
            </div>
            <div>
              <p className="font-medium text-gray-800">
                A record is saved to your account
              </p>
              <p className="text-gray-600 text-sm mt-1">
                atprotofans writes a small record to your AT Protocol account —
                think of it like a badge that lives alongside your profile and
                posts. It's your data, stored on your own server.
              </p>
            </div>
          </div>

          <div className="flex gap-4">
            <div
              className="flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center text-white text-sm font-bold"
              style={{ backgroundColor: "var(--coral)" }}
            >
              3
            </div>
            <div>
              <p className="font-medium text-gray-800">
                kipclip recognizes you as a supporter
              </p>
              <p className="text-gray-600 text-sm mt-1">
                Next time you sign in, kipclip reads that record from your
                account and unlocks supporter features automatically. No
                separate login or subscription needed.
              </p>
            </div>
          </div>
        </div>
        <p className="text-gray-600 text-sm border-t border-gray-100 pt-4 mt-2">
          Because this all happens through AT Protocol, any compatible app can
          check your supporter status — it's not locked to kipclip.
        </p>
      </section>
    </PageShell>
  );
}
