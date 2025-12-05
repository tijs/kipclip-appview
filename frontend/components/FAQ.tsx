/** @jsxImportSource https://esm.sh/react@19 */

export function FAQ() {
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
            Back to Home
          </a>
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-4 py-12 space-y-8">
        <section>
          <h2 className="text-3xl font-bold text-gray-800 mb-3">
            Frequently Asked Questions
          </h2>
          <p className="text-gray-700 text-lg">
            Everything you need to know about using kipclip with Bluesky and AT
            Protocol.
          </p>
        </section>

        <section className="bg-white rounded-lg shadow-md p-6 space-y-6">
          <div>
            <h3 className="text-xl font-bold text-gray-800 mb-2">
              What is AT Protocol?
            </h3>
            <p className="text-gray-700">
              AT Protocol is an open, decentralized social networking protocol.
              It's the technology that powers Bluesky and allows your data to be
              portable across different apps and services. Think of it like
              email - you own your address and can use it with different email
              clients.
            </p>
          </div>

          <div>
            <h3 className="text-xl font-bold text-gray-800 mb-2">
              Can I use my Bluesky account to sign in?
            </h3>
            <p className="text-gray-700">
              Yes! Your Bluesky account is an AT Protocol account. Just enter
              your Bluesky handle (like alice.bsky.social) to sign in. kipclip
              works seamlessly with Bluesky because they both use AT Protocol.
            </p>
          </div>

          <div>
            <h3 className="text-xl font-bold text-gray-800 mb-2">
              How does the login process work?
            </h3>
            <p className="text-gray-700">
              When you sign in, kipclip uses OAuth to securely connect to your
              Personal Data Server (PDS). This is the same secure login method
              used by apps like Twitter or Google. You'll be redirected to your
              PDS to authorize kipclip, then redirected back. Your password is
              never shared with kipclip.
            </p>
          </div>

          <div>
            <h3 className="text-xl font-bold text-gray-800 mb-2">
              Where are my bookmarks stored?
            </h3>
            <p className="text-gray-700">
              Your bookmarks are stored in your own Personal Data Server (PDS),
              not on kipclip's servers. If you use Bluesky, that's your Bluesky
              PDS. This means you own your data and can access it with other AT
              Protocol apps that support the bookmark format.
            </p>
          </div>

          <div>
            <h3 className="text-xl font-bold text-gray-800 mb-2">
              Can I share my bookmarks?
            </h3>
            <p className="text-gray-700">
              Yes! You can tag your bookmarks with custom labels, and kipclip
              automatically creates shareable collections based on those tags.
              Each collection gets its own unique URL with custom preview cards
              when shared on social media, making it easy to share curated lists
              with others.
            </p>
          </div>

          <div>
            <h3 className="text-xl font-bold text-gray-800 mb-2">
              Can I use a custom domain as my handle?
            </h3>
            <p className="text-gray-700">
              Yes! If you've set up a custom domain handle with AT Protocol
              (like yourname.com), you can use it to sign in to kipclip. Just
              enter your custom domain handle instead of a .bsky.social handle.
            </p>
          </div>

          <div>
            <h3 className="text-xl font-bold text-gray-800 mb-2">
              Is my data portable?
            </h3>
            <p className="text-gray-700">
              Absolutely! Because your bookmarks are stored using the community
              bookmark lexicon on your PDS, you can access them with any other
              AT Protocol app that supports this format. You're not locked into
              kipclip - your data is truly yours.
            </p>
          </div>

          <div>
            <h3 className="text-xl font-bold text-gray-800 mb-2">
              What happens if I move to a different PDS?
            </h3>
            <p className="text-gray-700">
              Your bookmarks move with you! When you migrate your account to a
              different PDS (using tools like{" "}
              <a
                href="https://pdsmoover.com"
                target="_blank"
                rel="noopener"
                className="underline hover:text-gray-800"
              >
                pdsmoover.com
              </a>
              ), all your data including bookmarks transfers automatically.
              They're tied to your account, not to kipclip or any specific
              server.
            </p>
          </div>

          <div>
            <h3 className="text-xl font-bold text-gray-800 mb-2">
              What happens to my bookmarks if kipclip shuts down?
            </h3>
            <p className="text-gray-700">
              Your bookmarks remain safe on your PDS - they're just JSON files
              stored with your account data. You could use another app that
              supports the community bookmark lexicon, or even build your own
              tool. Since kipclip is open source, you or anyone else could also
              host a copy of it.
            </p>
          </div>

          <div>
            <h3 className="text-xl font-bold text-gray-800 mb-2">
              Are my bookmarks private?
            </h3>
            <p className="text-gray-700">
              No, AT Protocol records are public by default. This means
              bookmarks you save with kipclip can be discovered by others.
              Please don't save anything sensitive or private. Think of kipclip
              bookmarks like public social media posts.
            </p>
          </div>

          <div>
            <h3 className="text-xl font-bold text-gray-800 mb-2">
              What is the community bookmark lexicon?
            </h3>
            <p className="text-gray-700">
              A lexicon is like a data schema in AT Protocol. The{" "}
              <a
                href="https://github.com/lexicon-community/lexicon/blob/main/community/lexicon/bookmarks/bookmark.json"
                target="_blank"
                rel="noopener noreferrer"
                className="underline hover:text-gray-800"
              >
                community bookmark lexicon
              </a>{" "}
              defines the standard format for bookmarks. By using this standard,
              kipclip ensures your bookmarks can be read by other compatible
              apps.
            </p>
          </div>

          <div>
            <h3 className="text-xl font-bold text-gray-800 mb-2">
              Does kipclip support RSS feeds?
            </h3>
            <p className="text-gray-700">
              Absolutely! Every shared collection has its own RSS feed that you
              can subscribe to in your favorite RSS reader. Simply add "/rss" to
              the end of any collection URL to access the feed. RSS readers will
              also auto-discover the feed when you visit a collection page.
            </p>
          </div>

          <div>
            <h3 className="text-xl font-bold text-gray-800 mb-2">
              Is kipclip affiliated with Bluesky?
            </h3>
            <p className="text-gray-700">
              No, kipclip is an independent project built on top of AT Protocol.
              It's designed to work with any AT Protocol account, including
              Bluesky accounts, but it's not officially affiliated with Bluesky
              Social PBC.
            </p>
          </div>
        </section>

        <section className="bg-white rounded-lg shadow-md p-6">
          <h3 className="text-xl font-bold text-gray-800 mb-4">
            Still have questions?
          </h3>
          <p className="text-gray-700 mb-4">
            Check out the{" "}
            <a
              href="/about"
              className="underline hover:text-gray-800"
            >
              About page
            </a>{" "}
            for more information, or reach out on{" "}
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
    </div>
  );
}
