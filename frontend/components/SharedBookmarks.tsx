import { useEffect, useState } from "react";
import type { EnrichedBookmark } from "../../shared/types.ts";

interface SharedBookmarksProps {
  did: string;
  encodedTags: string;
}

export function SharedBookmarks({ did, encodedTags }: SharedBookmarksProps) {
  const [bookmarks, setBookmarks] = useState<EnrichedBookmark[]>([]);
  const [handle, setHandle] = useState<string>("");
  const [tags, setTags] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadSharedBookmarks();
  }, [did, encodedTags]);

  // Update meta tags for Open Graph sharing
  useEffect(() => {
    if (!handle || tags.length === 0) return;

    const title = `${handle}'s Bookmarks Collection: ${tags.join(", ")}`;
    const description = bookmarks.length > 0
      ? `${bookmarks.length} bookmark${
        bookmarks.length === 1 ? "" : "s"
      } tagged with ${tags.join(", ")}`
      : `Bookmark collection tagged with ${tags.join(", ")}`;
    const url = globalThis.location.href;

    // Update document title
    document.title = title;

    // Update or create meta tags
    updateMetaTag("og:title", title);
    updateMetaTag("og:description", description);
    updateMetaTag("og:url", url);
    updateMetaTag("og:type", "website");
    updateMetaTag("og:site_name", "kipclip");

    // Twitter Card tags
    updateMetaTag("twitter:card", "summary", "name");
    updateMetaTag("twitter:title", title, "name");
    updateMetaTag("twitter:description", description, "name");

    // Cleanup function to restore original title
    return () => {
      document.title = "kipclip";
    };
  }, [handle, tags, bookmarks.length]);

  function updateMetaTag(
    property: string,
    content: string,
    attributeName: "property" | "name" = "property",
  ) {
    let meta = document.querySelector(
      `meta[${attributeName}="${property}"]`,
    ) as HTMLMetaElement;

    if (!meta) {
      meta = document.createElement("meta");
      meta.setAttribute(attributeName, property);
      document.head.appendChild(meta);
    }

    meta.content = content;
  }

  async function loadSharedBookmarks() {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`/api/share/${did}/${encodedTags}`);
      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || "Failed to load shared bookmarks");
      }
      const data = await response.json();
      setBookmarks(data.bookmarks);
      setHandle(data.handle);
      setTags(data.tags);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  function handleVisit(e: React.MouseEvent, url: string) {
    e.stopPropagation();
    globalThis.open(url, "_blank", "noopener,noreferrer");
  }

  async function handleShare(e: React.MouseEvent, bookmark: any) {
    e.stopPropagation();

    const shareData = {
      title: bookmark.title || new URL(bookmark.subject).hostname,
      text: bookmark.description
        ? `${
          bookmark.title || new URL(bookmark.subject).hostname
        }\n\n${bookmark.description}`
        : bookmark.title || new URL(bookmark.subject).hostname,
      url: bookmark.subject,
    };

    // Check if Web Share API is supported
    if (navigator.share) {
      try {
        await navigator.share(shareData);
      } catch (err: any) {
        // User cancelled or share failed
        if (err.name !== "AbortError") {
          console.error("Share failed:", err);
        }
      }
    } else {
      // Fallback: copy to clipboard
      try {
        const textToCopy =
          `${shareData.title}\n${shareData.text}\n${shareData.url}`;
        await navigator.clipboard.writeText(textToCopy);
        alert("Link copied to clipboard!");
      } catch (err) {
        console.error("Failed to copy:", err);
        alert("Sharing not supported on this browser");
      }
    }
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="spinner"></div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="text-center py-20 px-4">
          <div className="mb-6">
            <span className="text-6xl">⚠️</span>
          </div>
          <h3 className="text-xl font-semibold text-gray-700 mb-2">
            Error Loading Bookmarks
          </h3>
          <p className="text-red-600 mb-6">{error}</p>
          <button
            type="button"
            onClick={loadSharedBookmarks}
            className="btn-primary"
          >
            Try Again
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-7xl mx-auto px-4 py-8">
        {/* Header */}
        <div className="mb-8">
          <div className="flex items-center gap-2 text-sm text-gray-600 mb-2">
            <span>Shared by</span>
            <a
              href={`https://bsky.app/profile/${handle}`}
              target="_blank"
              rel="noopener noreferrer"
              className="font-semibold text-blue-600 hover:text-blue-800 hover:underline"
            >
              {handle}
            </a>
          </div>
          <h1 className="text-3xl font-bold text-gray-800 mb-4">
            Bookmarks Collection
          </h1>
          <div className="flex flex-wrap gap-2">
            <span className="text-sm text-gray-600">Filtered by tags:</span>
            {tags.map((tag) => (
              <span
                key={tag}
                className="px-3 py-1 text-sm rounded-full bg-blue-100 text-blue-700 font-medium"
              >
                {tag}
              </span>
            ))}
          </div>
        </div>

        {/* Bookmarks */}
        {bookmarks.length === 0
          ? (
            <div className="text-center py-20">
              <div className="mb-6">
                <span className="text-6xl">📚</span>
              </div>
              <h3 className="text-xl font-semibold text-gray-700 mb-2">
                No bookmarks found
              </h3>
              <p className="text-gray-500">
                This user hasn't shared any bookmarks with these tags yet.
              </p>
            </div>
          )
          : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {bookmarks.map((bookmark) => (
                <div
                  key={bookmark.uri}
                  className="card hover:scale-[1.02] transition-all group relative"
                >
                  <div className="mb-3">
                    <h3 className="font-semibold text-gray-800 truncate mb-1">
                      {bookmark.title || new URL(bookmark.subject).hostname}
                    </h3>
                    <div className="text-sm text-gray-500 truncate">
                      {bookmark.subject}
                    </div>
                  </div>

                  {bookmark.description && (
                    <p className="text-sm text-gray-600 mb-3 line-clamp-2">
                      {bookmark.description}
                    </p>
                  )}

                  <div className="text-xs text-gray-400">
                    {new Date(bookmark.createdAt).toLocaleDateString()}
                  </div>

                  {/* Desktop: hover-reveal buttons (bottom-right) */}
                  <div className="hidden md:group-hover:flex absolute bottom-2 right-2 gap-1">
                    <button
                      type="button"
                      onClick={(e) => handleVisit(e, bookmark.subject)}
                      className="w-7 h-7 flex items-center justify-center text-gray-600 hover:text-gray-900 bg-white/90 hover:bg-white rounded-md transition-colors shadow-sm"
                      title="Visit bookmark"
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
                          d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"
                        />
                      </svg>
                    </button>
                    <button
                      type="button"
                      onClick={(e) => handleShare(e, bookmark)}
                      className="w-7 h-7 flex items-center justify-center text-gray-600 hover:text-gray-900 bg-white/90 hover:bg-white rounded-md transition-colors shadow-sm"
                      title="Share bookmark"
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
                          d="M8.684 13.342C8.886 12.938 9 12.482 9 12c0-.482-.114-.938-.316-1.342m0 2.684a3 3 0 110-2.684m0 2.684l6.632 3.316m-6.632-6l6.632-3.316m0 0a3 3 0 105.367-2.684 3 3 0 00-5.367 2.684zm0 9.316a3 3 0 105.368 2.684 3 3 0 00-5.368-2.684z"
                        />
                      </svg>
                    </button>
                  </div>

                  {/* Mobile: always-visible buttons (bottom-right) */}
                  <div className="flex md:hidden absolute bottom-2 right-2 gap-1">
                    <button
                      type="button"
                      onClick={(e) => handleVisit(e, bookmark.subject)}
                      className="w-8 h-8 flex items-center justify-center text-gray-600 hover:text-gray-900 bg-white/90 hover:bg-white rounded-md transition-colors shadow-sm"
                      title="Visit bookmark"
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
                          d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"
                        />
                      </svg>
                    </button>
                    <button
                      type="button"
                      onClick={(e) => handleShare(e, bookmark)}
                      className="w-8 h-8 flex items-center justify-center text-gray-600 hover:text-gray-900 bg-white/90 hover:bg-white rounded-md transition-colors shadow-sm"
                      title="Share bookmark"
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
                          d="M8.684 13.342C8.886 12.938 9 12.482 9 12c0-.482-.114-.938-.316-1.342m0 2.684a3 3 0 110-2.684m0 2.684l6.632 3.316m-6.632-6l6.632-3.316m0 0a3 3 0 105.367-2.684 3 3 0 00-5.367 2.684zm0 9.316a3 3 0 105.368 2.684 3 3 0 00-5.368-2.684z"
                        />
                      </svg>
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}

        {/* Footer */}
        <div className="mt-12 pt-8 border-t border-gray-200 text-center">
          <p className="text-sm text-gray-600">
            Create your own bookmark collection at{" "}
            <a
              href="/"
              className="text-blue-600 hover:underline font-medium"
            >
              kipclip.com
            </a>
          </p>
        </div>
      </div>
    </div>
  );
}
