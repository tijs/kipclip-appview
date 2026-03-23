import { Footer } from "./Footer.tsx";

const CDN = "https://cdn.kipclip.com";

const assets = [
  {
    name: "Mascot (with background)",
    filename: "kip-satchel.png",
    description: "Full mascot illustration on blue background",
  },
  {
    name: "Mascot (transparent)",
    filename: "kip-satchel-transparent.png",
    description: "Full mascot illustration on transparent background",
  },
  {
    name: "Kip",
    filename: "kip-vignette.png",
    description: "Kip mascot portrait",
  },
  {
    name: "Kip B&W (PNG)",
    filename: "kip-vignette-bw.png",
    description: "Black and white Kip mascot portrait",
  },
  {
    name: "Kip B&W (SVG)",
    filename: "kip-vignette-bw.svg",
    description: "Black and white Kip mascot portrait in vector format",
  },
  {
    name: "Logo (SVG)",
    filename: "kipclip.svg",
    description: "kipclip logo in vector format",
  },
];

function DownloadCard(
  { name, filename, description }: {
    name: string;
    filename: string;
    description: string;
  },
) {
  const url = `${CDN}/images/${filename}`;
  const isSvg = filename.endsWith(".svg");

  return (
    <div className="bg-white rounded-lg shadow-md overflow-hidden">
      <div
        className="flex items-center justify-center p-6"
        style={{
          backgroundColor: isSvg ? "var(--cream)" : undefined,
          backgroundImage: !isSvg
            ? "linear-gradient(45deg, #e0e0e0 25%, transparent 25%, transparent 75%, #e0e0e0 75%), linear-gradient(45deg, #e0e0e0 25%, transparent 25%, transparent 75%, #e0e0e0 75%)"
            : undefined,
          backgroundSize: !isSvg ? "16px 16px" : undefined,
          backgroundPosition: !isSvg ? "0 0, 8px 8px" : undefined,
        }}
      >
        <img
          src={url}
          alt={name}
          className="max-h-40 object-contain"
        />
      </div>
      <div className="p-4 border-t border-gray-100">
        <h4 className="font-semibold text-gray-800">{name}</h4>
        <p className="text-sm text-gray-500 mt-1">{description}</p>
        <a
          href={url}
          download={filename}
          className="inline-flex items-center gap-1 mt-3 text-sm font-medium hover:opacity-80"
          style={{ color: "var(--coral)" }}
        >
          <svg
            className="w-4 h-4"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2M7 10l5 5m0 0l5-5m-5 5V3"
            />
          </svg>
          Download
        </a>
      </div>
    </div>
  );
}

export function Press() {
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
            Press Kit
          </h2>
          <p className="text-gray-700 text-lg">
            Resources for writing about kipclip. Feel free to use these assets
            in articles, blog posts, and other media.
          </p>
        </section>

        <section className="bg-white rounded-lg shadow-md p-6 space-y-3">
          <h3 className="text-xl font-bold text-gray-800">About kipclip</h3>
          <p className="text-gray-700">
            kipclip is a free, open bookmark manager built on{" "}
            <a
              href="https://atproto.com"
              target="_blank"
              rel="noopener noreferrer"
              className="underline hover:text-gray-800"
            >
              AT Protocol
            </a>
            . Users sign in with their Bluesky account and their bookmarks are
            stored on their own personal data server — not on kipclip's
            infrastructure. This means users own their data and can take it with
            them.
          </p>
          <div className="bg-gray-50 rounded-md p-4 mt-2">
            <p className="text-sm text-gray-500 mb-1 font-medium">
              Short description (for bios, listings, etc.)
            </p>
            <p className="text-gray-700 italic">
              "kipclip is a free, open bookmark manager for the AT Protocol
              ecosystem. Save links, organize with tags, own your data."
            </p>
          </div>
        </section>

        <section className="bg-white rounded-lg shadow-md p-6 space-y-3">
          <h3 className="text-xl font-bold text-gray-800">Key Facts</h3>
          <ul className="list-disc pl-5 text-gray-700 space-y-2">
            <li>
              <strong>What:</strong>{" "}
              Bookmark manager for the AT Protocol / Bluesky ecosystem
            </li>
            <li>
              <strong>Built on:</strong>{" "}
              AT Protocol (open standard for decentralized social)
            </li>
            <li>
              <strong>Data ownership:</strong>{" "}
              Bookmarks stored on user's Personal Data Server (PDS), not kipclip
              servers
            </li>
            <li>
              <strong>Price:</strong> Free
            </li>
            <li>
              <strong>Source:</strong>{" "}
              <a
                href="https://github.com/tijs/kipclip-appview"
                target="_blank"
                rel="noopener noreferrer"
                className="underline hover:text-gray-800"
              >
                Open source on GitHub
              </a>
            </li>
            <li>
              <strong>Creator:</strong>{" "}
              <a
                href="https://bsky.app/profile/tijs.org"
                target="_blank"
                rel="noopener noreferrer"
                className="underline hover:text-gray-800"
              >
                tijs.org
              </a>
            </li>
            <li>
              <strong>Website:</strong>{" "}
              <a
                href="https://kipclip.com"
                className="underline hover:text-gray-800"
              >
                kipclip.com
              </a>
            </li>
          </ul>
        </section>

        <section className="space-y-4">
          <h3 className="text-xl font-bold text-gray-800">Brand Assets</h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {assets.map((asset) => (
              <DownloadCard key={asset.filename} {...asset} />
            ))}
          </div>
        </section>

        <section className="bg-white rounded-lg shadow-md p-6 space-y-3">
          <h3 className="text-xl font-bold text-gray-800">Brand Colors</h3>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {[
              { name: "Coral", var: "--coral", hex: "#e66456" },
              { name: "Teal", var: "--teal", hex: "#5b8a8f" },
              { name: "Orange", var: "--orange", hex: "#f4a261" },
              { name: "Cream", var: "--cream", hex: "#f5f1e8" },
            ].map((color) => (
              <div key={color.var} className="text-center">
                <div
                  className="w-full h-16 rounded-lg mb-2 border border-gray-200"
                  style={{ backgroundColor: color.hex }}
                />
                <p className="text-sm font-medium text-gray-800">
                  {color.name}
                </p>
                <p className="text-xs text-gray-500">{color.hex}</p>
              </div>
            ))}
          </div>
        </section>

        <section className="bg-white rounded-lg shadow-md p-6 space-y-3">
          <h3 className="text-xl font-bold text-gray-800">Usage Guidelines</h3>
          <ul className="list-disc pl-5 text-gray-700 space-y-2">
            <li>
              Use "kipclip" in lowercase — it's not capitalized, even at the
              start of a sentence.
            </li>
            <li>Don't alter, rotate, or distort the logo or mascot.</li>
            <li>
              Keep adequate spacing around the logo when placing it alongside
              other elements.
            </li>
            <li>
              The mascot's name is Kip. Kip is a chicken with a satchel full of
              bookmarks.
            </li>
          </ul>
        </section>

        <section className="bg-white rounded-lg shadow-md p-6 space-y-3">
          <h3 className="text-xl font-bold text-gray-800">Contact</h3>
          <p className="text-gray-700">
            For press inquiries, reach out to{" "}
            <a
              href="https://bsky.app/profile/tijs.org"
              target="_blank"
              rel="noopener noreferrer"
              className="underline hover:text-gray-800"
            >
              tijs.org on Bluesky
            </a>
            .
          </p>
        </section>
      </main>

      <Footer />
    </div>
  );
}
