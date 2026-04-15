import { PageShell } from "./PageShell.tsx";

export function PrivacyPolicy() {
  return (
    <PageShell>
      <section>
        <h2 className="text-3xl font-bold text-gray-800 mb-3">
          Privacy Policy
        </h2>
        <p className="text-gray-500 text-sm">
          Last updated: March 23, 2026
        </p>
      </section>

      <section className="bg-white rounded-lg shadow-md p-6 space-y-4">
        <h3 className="text-xl font-bold text-gray-800">Overview</h3>
        <p className="text-gray-700">
          kipclip is a bookmark manager built on AT Protocol. We respect your
          privacy and collect as little data as possible. This policy explains
          what information we handle and how.
        </p>
      </section>

      <section className="bg-white rounded-lg shadow-md p-6 space-y-4">
        <h3 className="text-xl font-bold text-gray-800">
          Your bookmarks are public
        </h3>
        <p className="text-gray-700">
          Bookmarks and tags you save through kipclip are stored on your
          Personal Data Server (PDS) as part of your AT Protocol account. This
          data is public by design — anyone can discover and read your
          bookmarks, just like public posts on Bluesky. Do not save anything
          sensitive or private as a bookmark.
        </p>
      </section>

      <section className="bg-white rounded-lg shadow-md p-6 space-y-4">
        <h3 className="text-xl font-bold text-gray-800">
          Data we store on our servers
        </h3>
        <p className="text-gray-700">
          kipclip does not store your bookmarks. The only data we persist on our
          side is:
        </p>
        <ul className="list-disc pl-5 text-gray-700 space-y-2">
          <li>
            <strong>OAuth session tokens</strong>{" "}
            — temporary credentials used to keep you signed in. These are stored
            in a database and automatically expire.
          </li>
          <li>
            <strong>Session cookies</strong>{" "}
            — a secure, HTTP-only cookie that identifies your browser session.
            It contains no personal information.
          </li>
        </ul>
        <p className="text-gray-700">
          We do not maintain a user database, profile store, or any copy of your
          bookmarks.
        </p>
      </section>

      <section className="bg-white rounded-lg shadow-md p-6 space-y-4">
        <h3 className="text-xl font-bold text-gray-800">
          Analytics and tracking
        </h3>
        <p className="text-gray-700">
          We collect basic, anonymous visitor statistics to understand how the
          site is used — such as page views and referral sources. This tracking
          is entirely self-hosted and does not use any third-party analytics
          services. No data is shared with advertisers, data brokers, or
          external companies.
        </p>
        <p className="text-gray-700">
          We do not use tracking pixels, fingerprinting, or cross-site tracking
          of any kind.
        </p>
      </section>

      <section className="bg-white rounded-lg shadow-md p-6 space-y-4">
        <h3 className="text-xl font-bold text-gray-800">
          Authentication
        </h3>
        <p className="text-gray-700">
          kipclip uses AT Protocol OAuth for authentication. When you sign in,
          you are redirected to your account provider (such as Bluesky) to
          authorize access. Your password is never shared with or stored by
          kipclip.
        </p>
      </section>

      <section className="bg-white rounded-lg shadow-md p-6 space-y-4">
        <h3 className="text-xl font-bold text-gray-800">Local storage</h3>
        <p className="text-gray-700">
          kipclip may cache bookmark data in your browser's IndexedDB for
          performance. This data stays on your device and is cleared when you
          sign out.
        </p>
      </section>

      <section className="bg-white rounded-lg shadow-md p-6 space-y-4">
        <h3 className="text-xl font-bold text-gray-800">
          Third-party services
        </h3>
        <p className="text-gray-700">
          kipclip connects to the following external services as part of normal
          operation:
        </p>
        <ul className="list-disc pl-5 text-gray-700 space-y-2">
          <li>
            <strong>Your AT Protocol PDS</strong>{" "}
            — to read and write your bookmarks and tags
          </li>
          <li>
            <strong>Your account provider's OAuth server</strong>{" "}
            — to authenticate your identity
          </li>
          <li>
            <strong>Sentry</strong>{" "}
            — for error monitoring to help us fix bugs (no personal data is
            intentionally collected)
          </li>
        </ul>
      </section>

      <section className="bg-white rounded-lg shadow-md p-6 space-y-4">
        <h3 className="text-xl font-bold text-gray-800">Data ownership</h3>
        <p className="text-gray-700">
          Your bookmarks and tags belong to you. They are stored on your PDS,
          not on kipclip's servers. If kipclip shuts down, your data remains
          intact and accessible through other AT Protocol clients. You can
          delete your bookmarks at any time through kipclip or any compatible
          app.
        </p>
      </section>

      <section className="bg-white rounded-lg shadow-md p-6 space-y-4">
        <h3 className="text-xl font-bold text-gray-800">Contact</h3>
        <p className="text-gray-700">
          If you have questions about this privacy policy, reach out on{" "}
          <a
            href="https://bsky.app/profile/tijs.org"
            target="_blank"
            rel="noopener noreferrer"
            className="underline hover:text-gray-800"
          >
            Bluesky
          </a>
          .
        </p>
      </section>
    </PageShell>
  );
}
