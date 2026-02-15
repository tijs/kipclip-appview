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
            Everything you need to know about using kipclip.
          </p>
        </section>

        {/* Section 1: Using kipclip */}
        <section>
          <h3
            className="text-2xl font-bold mb-4"
            style={{ color: "var(--coral)" }}
          >
            Using kipclip
          </h3>
          <div className="bg-white rounded-lg shadow-md p-6 space-y-6">
            <div>
              <h4 className="text-xl font-bold text-gray-800 mb-2">
                How do I create an account?
              </h4>
              <p className="text-gray-700">
                Creating an account is free. You can sign up through{" "}
                <a
                  href="https://bsky.app"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline hover:text-gray-800"
                >
                  Bluesky
                </a>
                ,{" "}
                <a
                  href="https://blacksky.community"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline hover:text-gray-800"
                >
                  Blacksky
                </a>
                , or{" "}
                <a
                  href="https://www.eurosky.tech/register"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline hover:text-gray-800"
                >
                  Eurosky
                </a>
                . Your account works across kipclip and a growing number of apps
                in the same ecosystem. Visit the{" "}
                <a href="/create-account" className="underline hover:text-gray-800">
                  registration page
                </a>{" "}
                to get started.
              </p>
            </div>

            <div>
              <h4 className="text-xl font-bold text-gray-800 mb-2">
                How do I sign in?
              </h4>
              <p className="text-gray-700">
                Enter your username (like alice.bsky.social) on the sign-in
                page. You'll be securely redirected to authorize kipclip, then
                sent back. Your password is never shared with kipclip.
              </p>
            </div>

            <div>
              <h4 className="text-xl font-bold text-gray-800 mb-2">
                Where are my bookmarks stored?
              </h4>
              <p className="text-gray-700">
                In your own account, not on kipclip's servers. You own your
                data, and other compatible apps can access your bookmarks too.
              </p>
            </div>

            <div>
              <h4 className="text-xl font-bold text-gray-800 mb-2">
                Are my bookmarks private?
              </h4>
              <p className="text-gray-700">
                No, bookmarks are public by default and can be discovered by
                others. Don't save anything sensitive or private. Think of
                kipclip bookmarks like public social media posts.
              </p>
            </div>

            <div>
              <h4 className="text-xl font-bold text-gray-800 mb-2">
                Can I share my bookmarks?
              </h4>
              <p className="text-gray-700">
                Yes! You can tag your bookmarks with custom labels, and kipclip
                automatically creates shareable collections based on those tags.
                Each collection gets its own unique URL with custom preview
                cards when shared on social media, making it easy to share
                curated lists with others.
              </p>
            </div>

            <div>
              <h4 className="text-xl font-bold text-gray-800 mb-2">
                What happens if kipclip shuts down?
              </h4>
              <p className="text-gray-700">
                Your bookmarks stay safe in your account. They're not locked
                into kipclip — you could use another compatible app, or even
                host your own copy since kipclip is open source.
              </p>
            </div>

            <div>
              <h4 className="text-xl font-bold text-gray-800 mb-2">
                Can I install kipclip on my phone?
              </h4>
              <p className="text-gray-700">
                Yes! You can add kipclip to your home screen on both Android and
                iOS, and it will work like a native app. On Android, use "Add to
                Home screen" or "Install app" in Chrome — kipclip will then
                appear in your share menu, letting you save bookmarks directly
                from any app. On iOS, use "Add to Home Screen" from Safari's
                share menu, then use the iOS Shortcut to save bookmarks. See the
                {" "}
                <a href="/tools" className="underline hover:text-gray-800">
                  Tools page
                </a>{" "}
                for detailed installation instructions.
              </p>
            </div>

            <div>
              <h4 className="text-xl font-bold text-gray-800 mb-2">
                Does kipclip support RSS feeds?
              </h4>
              <p className="text-gray-700">
                Absolutely! Every shared collection has its own RSS feed that
                you can subscribe to in your favorite RSS reader. Simply add
                "/rss" to the end of any collection URL to access the feed. RSS
                readers will also auto-discover the feed when you visit a
                collection page.
              </p>
            </div>
          </div>
        </section>

        {/* Section 2: How the technology works */}
        <section>
          <h3
            className="text-2xl font-bold mb-2"
            style={{ color: "var(--coral)" }}
          >
            How the technology works
          </h3>
          <p className="text-gray-600 mb-4">
            kipclip is built on the Atmosphere — an open ecosystem of apps that
            share a common account system. Here's how it works under the hood.
          </p>
          <div className="bg-white rounded-lg shadow-md p-6 space-y-6">
            <div>
              <h4 className="text-xl font-bold text-gray-800 mb-2">
                What is AT Protocol?
              </h4>
              <p className="text-gray-700">
                AT Protocol is an open, decentralized social networking
                protocol. It's the technology that powers Bluesky and allows
                your data to be portable across different apps and services.
                Think of it like email — you own your address and can use it
                with different clients.
              </p>
            </div>

            <div>
              <h4 className="text-xl font-bold text-gray-800 mb-2">
                What is a Personal Data Server (PDS)?
              </h4>
              <p className="text-gray-700">
                A PDS is where your account data lives — your profile, posts,
                bookmarks, and everything else. When you create a Bluesky
                account, you get a PDS automatically. Your bookmarks are stored
                there as structured records, which is why they stay with you
                even if kipclip goes away.
              </p>
            </div>

            <div>
              <h4 className="text-xl font-bold text-gray-800 mb-2">
                What is the community bookmark lexicon?
              </h4>
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
                defines the standard format for bookmarks. By using this
                standard, kipclip ensures your bookmarks can be read by other
                compatible apps.
              </p>
            </div>

            <div>
              <h4 className="text-xl font-bold text-gray-800 mb-2">
                What is the Atmosphere?
              </h4>
              <p className="text-gray-700">
                The Atmosphere is the ecosystem of apps and services built on AT
                Protocol. Bluesky, kipclip, and many other apps are all part of
                it. Because they share the same account system and data
                standards, you can use one account across all of them and take
                your data with you.
              </p>
            </div>

            <div>
              <h4 className="text-xl font-bold text-gray-800 mb-2">
                Can I use a custom domain as my handle?
              </h4>
              <p className="text-gray-700">
                Yes! If you've set up a custom domain handle with AT Protocol
                (like yourname.com), you can use it to sign in to kipclip. Just
                enter your custom domain handle instead of a .bsky.social
                handle.
              </p>
            </div>

            <div>
              <h4 className="text-xl font-bold text-gray-800 mb-2">
                Is my data portable?
              </h4>
              <p className="text-gray-700">
                Absolutely! Because your bookmarks are stored using the
                community bookmark lexicon on your PDS, you can access them with
                any other AT Protocol app that supports this format. You're not
                locked into kipclip — your data is truly yours.
              </p>
            </div>

            <div>
              <h4 className="text-xl font-bold text-gray-800 mb-2">
                What happens if I move to a different server?
              </h4>
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
              <h4 className="text-xl font-bold text-gray-800 mb-2">
                Is kipclip affiliated with Bluesky?
              </h4>
              <p className="text-gray-700">
                No, kipclip is an independent project built on AT Protocol. It
                works with any AT Protocol account, including Bluesky accounts,
                but it's not officially affiliated with Bluesky Social PBC.
              </p>
            </div>

            <div>
              <h4 className="text-xl font-bold text-gray-800 mb-2">
                What are account providers?
              </h4>
              <p className="text-gray-700">
                Account providers host your account and data. Bluesky, Blacksky,
                and Eurosky are popular providers — and more are being
                developed. You can create an account with any provider and use
                it across all Atmosphere apps including kipclip.
              </p>
            </div>
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
