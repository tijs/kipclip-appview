import { Footer } from "./Footer.tsx";

export function TermsOfUse() {
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
            Terms of Use
          </h2>
          <p className="text-gray-500 text-sm">
            Last updated: March 23, 2026
          </p>
        </section>

        <section className="bg-white rounded-lg shadow-md p-6 space-y-4">
          <h3 className="text-xl font-bold text-gray-800">
            What kipclip is
          </h3>
          <p className="text-gray-700">
            kipclip is a free, open-source bookmark manager built on AT
            Protocol. It lets you save, organize, and share links using your
            existing AT Protocol account. By using kipclip, you agree to these
            terms.
          </p>
        </section>

        <section className="bg-white rounded-lg shadow-md p-6 space-y-4">
          <h3 className="text-xl font-bold text-gray-800">Your account</h3>
          <p className="text-gray-700">
            kipclip does not create or manage accounts. You sign in with your
            existing AT Protocol account (such as a Bluesky account). You are
            responsible for keeping your account credentials secure. kipclip
            never has access to your password.
          </p>
        </section>

        <section className="bg-white rounded-lg shadow-md p-6 space-y-4">
          <h3 className="text-xl font-bold text-gray-800">
            Public bookmarks
          </h3>
          <p className="text-gray-700">
            All bookmarks and tags you save through kipclip are stored publicly
            on your Personal Data Server (PDS). This means anyone can view your
            bookmarks. You are responsible for the content you bookmark — do not
            save links to illegal, harmful, or abusive content.
          </p>
        </section>

        <section className="bg-white rounded-lg shadow-md p-6 space-y-4">
          <h3 className="text-xl font-bold text-gray-800">
            Your data, your responsibility
          </h3>
          <p className="text-gray-700">
            Your bookmarks belong to you and live on your PDS, not on kipclip's
            servers. kipclip acts as a client to read and write this data on
            your behalf. We do not control or moderate the content of your
            bookmarks.
          </p>
        </section>

        <section className="bg-white rounded-lg shadow-md p-6 space-y-4">
          <h3 className="text-xl font-bold text-gray-800">
            Service availability
          </h3>
          <p className="text-gray-700">
            kipclip is provided as-is, without guarantees of uptime or
            availability. We may update, change, or discontinue the service at
            any time. Since your data lives on your PDS, it remains accessible
            through other AT Protocol clients even if kipclip becomes
            unavailable.
          </p>
        </section>

        <section className="bg-white rounded-lg shadow-md p-6 space-y-4">
          <h3 className="text-xl font-bold text-gray-800">
            Acceptable use
          </h3>
          <p className="text-gray-700">
            You agree not to misuse kipclip. This includes but is not limited
            to:
          </p>
          <ul className="list-disc pl-5 text-gray-700 space-y-2">
            <li>Automated scraping or abuse of the service</li>
            <li>Attempting to access other users' sessions or data</li>
            <li>Using kipclip to distribute spam or malicious content</li>
            <li>Interfering with the operation of the service</li>
          </ul>
        </section>

        <section className="bg-white rounded-lg shadow-md p-6 space-y-4">
          <h3 className="text-xl font-bold text-gray-800">Open source</h3>
          <p className="text-gray-700">
            kipclip is open-source software. The source code is available on
            {" "}
            <a
              href="https://github.com/tijs/kipclip-appview"
              target="_blank"
              rel="noopener noreferrer"
              className="underline hover:text-gray-800"
            >
              GitHub
            </a>
            . You are free to run your own instance.
          </p>
        </section>

        <section className="bg-white rounded-lg shadow-md p-6 space-y-4">
          <h3 className="text-xl font-bold text-gray-800">
            Limitation of liability
          </h3>
          <p className="text-gray-700">
            kipclip is a personal project offered free of charge. To the fullest
            extent permitted by law, kipclip and its creator are not liable for
            any damages arising from your use of the service, including loss of
            data, downtime, or issues with third-party services such as your PDS
            provider.
          </p>
        </section>

        <section className="bg-white rounded-lg shadow-md p-6 space-y-4">
          <h3 className="text-xl font-bold text-gray-800">Changes</h3>
          <p className="text-gray-700">
            We may update these terms from time to time. Continued use of
            kipclip after changes constitutes acceptance of the updated terms.
          </p>
        </section>

        <section className="bg-white rounded-lg shadow-md p-6 space-y-4">
          <h3 className="text-xl font-bold text-gray-800">Contact</h3>
          <p className="text-gray-700">
            Questions about these terms? Reach out on{" "}
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
      </main>

      <Footer />
    </div>
  );
}
