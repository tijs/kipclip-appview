/**
 * "Already in the wild" — apps that read or write the same community
 * bookmark lexicon as kipclip. Static list curated against
 * https://atstore.fyi/products/kipclip/lexicon-compatible — atstore
 * doesn't expose this list as an XRPC method, so we maintain it
 * manually until they do.
 */

const CARD_SHADOW =
  "0 1px 2px rgba(20,30,40,0.04), 0 8px 24px -8px rgba(20,30,40,0.08)";

interface CompatibleApp {
  name: string;
  tagline: string;
  iconUrl: string;
  atstoreUrl: string;
}

const COMPATIBLE_APPS: CompatibleApp[] = [
  {
    name: "Margin",
    tagline: "Annotate any URL on the web — backed by AT Protocol.",
    iconUrl:
      "https://cdn.bsky.app/img/feed_fullsize/plain/did:plc:rjqn3agdb74cszhqcpii4sne/bafkreiadj53fs3oagj57ozoqvmd3eih27hqa7msj56l2umaebwr5wwmoje@png",
    atstoreUrl: "https://atstore.fyi/products/margin",
  },
  {
    name: "Disperse",
    tagline: "Share links to multiple Atmosphere apps at once.",
    iconUrl:
      "https://cdn.bsky.app/img/feed_fullsize/plain/did:plc:xgvzy7ni6ig6ievcbls5jaxe/bafkreibubecatsexscikcwimx45mg3trjdpbdcoifbpagity5i4zfiivw4@png",
    atstoreUrl: "https://atstore.fyi/products/disperse",
  },
];

function CompatibleAppCard(
  { app }: { key?: string; app: CompatibleApp },
) {
  return (
    <a
      href={app.atstoreUrl}
      target="_blank"
      rel="noopener noreferrer"
      className="flex items-center gap-4 bg-white rounded-2xl p-4 sm:p-5 ring-1 ring-gray-100 hover:-translate-y-px hover:shadow-md"
      style={{
        boxShadow: CARD_SHADOW,
        transitionProperty: "transform, box-shadow",
        transitionDuration: "150ms",
        transitionTimingFunction: "ease-out",
      }}
    >
      <img
        src={app.iconUrl}
        alt=""
        width={48}
        height={48}
        className="w-12 h-12 rounded-xl object-cover flex-shrink-0"
        style={{ outline: "1px solid rgba(20,30,40,0.06)" }}
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 mb-0.5">
          <span className="font-semibold text-gray-900 truncate">
            {app.name}
          </span>
          <svg
            className="w-3.5 h-3.5 text-gray-400 flex-shrink-0"
            fill="none"
            viewBox="0 0 24 24"
            strokeWidth={2}
            stroke="currentColor"
            aria-hidden
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M14 5l7 7m0 0l-7 7m7-7H3"
            />
          </svg>
        </div>
        <p
          className="text-sm text-gray-600 leading-snug"
          style={{ textWrap: "pretty" }}
        >
          {app.tagline}
        </p>
      </div>
    </a>
  );
}

export function CompatibleApps() {
  return (
    <div className="mb-10">
      <p
        className="text-center text-sm font-semibold uppercase tracking-wider mb-3"
        style={{ color: "var(--teal)" }}
      >
        Already in the wild
      </p>
      <p
        className="text-center text-base text-gray-600 mb-6 max-w-2xl mx-auto"
        style={{ textWrap: "pretty" }}
      >
        Other apps reading and writing the same{" "}
        <a
          href="https://github.com/lexicon-community/lexicon/blob/main/community/lexicon/bookmarks/bookmark.json"
          target="_blank"
          rel="noopener noreferrer"
          className="underline hover:text-gray-900"
        >
          community bookmark lexicon
        </a>{" "}
        — save in one, see it in another.
      </p>
      <div className="grid sm:grid-cols-2 gap-4 sm:gap-5">
        {COMPATIBLE_APPS.map((app) => (
          <CompatibleAppCard key={app.name} app={app} />
        ))}
      </div>
      <p className="text-center text-xs text-gray-400 mt-4">
        See the full list on{" "}
        <a
          href="https://atstore.fyi/products/kipclip/lexicon-compatible?sort=popular"
          target="_blank"
          rel="noopener noreferrer"
          className="underline hover:text-gray-600"
        >
          atstore.fyi
        </a>
      </p>
    </div>
  );
}
