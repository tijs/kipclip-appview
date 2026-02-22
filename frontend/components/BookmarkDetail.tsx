import { useEffect, useState } from "react";
import { formatDate } from "../../shared/date-format.ts";
import type { EnrichedBookmark } from "../../shared/types.ts";

interface BookmarkDetailProps {
  bookmark: EnrichedBookmark;
  onClose: () => void;
  onEdit: () => void;
  onShare: () => void;
  onOpen: () => void;
}

export function BookmarkDetail({
  bookmark,
  onClose,
  onEdit,
  onShare,
  onOpen,
}: BookmarkDetailProps) {
  const [imageError, setImageError] = useState(false);

  // Close on Escape key
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        onClose();
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  // Prevent body scroll when modal is open
  useEffect(() => {
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = "";
    };
  }, []);

  let hostname = "";
  try {
    hostname = new URL(bookmark.subject).hostname;
  } catch {
    hostname = bookmark.subject;
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-end md:items-center justify-center"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/50" />

      {/* Modal */}
      <div className="relative w-full md:max-w-2xl md:mx-4 bg-white md:rounded-xl rounded-t-xl max-h-[100dvh] md:max-h-[90vh] overflow-y-auto fade-in">
        {/* Close button */}
        <button
          type="button"
          onClick={onClose}
          className="absolute top-3 right-3 z-10 w-8 h-8 flex items-center justify-center rounded-full bg-white/80 backdrop-blur-sm text-gray-500 hover:text-gray-700 hover:bg-white transition"
          aria-label="Close"
        >
          <svg
            className="w-5 h-5"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M6 18L18 6M6 6l12 12"
            />
          </svg>
        </button>

        {/* Preview image */}
        {bookmark.image && !imageError && (
          <img
            src={bookmark.image}
            alt={bookmark.title || "Bookmark preview"}
            loading="lazy"
            onError={() => setImageError(true)}
            className="w-full h-48 md:h-64 object-cover md:rounded-t-xl rounded-t-xl"
          />
        )}

        <div className="p-5 space-y-4">
          {/* Title */}
          <h2 className="text-xl font-semibold text-gray-900">
            {bookmark.title || hostname}
          </h2>

          {/* URL */}
          <a
            href={bookmark.subject}
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm hover:underline break-all block"
            style={{ color: "var(--coral)" }}
            onClick={(e) => e.stopPropagation()}
          >
            {bookmark.subject}
          </a>

          {/* Description */}
          {bookmark.description && (
            <p className="text-sm text-gray-600 leading-relaxed">
              {bookmark.description}
            </p>
          )}

          {/* Tags */}
          {bookmark.tags && bookmark.tags.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {bookmark.tags.map((tag, i) => (
                <span
                  key={i}
                  className="px-2.5 py-1 text-xs rounded-full bg-gray-100 text-gray-700"
                >
                  {tag}
                </span>
              ))}
            </div>
          )}

          {/* Note */}
          {bookmark.note && (
            <div className="bg-amber-50 border border-amber-200 rounded-lg p-3">
              <div className="flex items-center gap-1.5 mb-1.5">
                <svg
                  className="w-4 h-4 text-amber-600"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"
                  />
                </svg>
                <span className="text-xs font-medium text-amber-700">Note</span>
              </div>
              <p className="text-sm text-gray-700 whitespace-pre-wrap">
                {bookmark.note}
              </p>
            </div>
          )}

          {/* Date and archive link */}
          <div className="text-xs text-gray-400 flex items-center gap-2">
            <span>Saved {formatDate(bookmark.createdAt)}</span>
            <span>·</span>
            <a
              href={`https://web.archive.org/web/${bookmark.subject}`}
              target="_blank"
              rel="noopener noreferrer"
              className="hover:underline"
              style={{ color: "var(--coral)" }}
              onClick={(e) => e.stopPropagation()}
            >
              Archived version
            </a>
          </div>

          {/* Action buttons */}
          <div className="flex gap-2.5 pt-2">
            <button
              type="button"
              onClick={onOpen}
              className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg text-white font-medium hover:opacity-90 transition"
              style={{ backgroundColor: "var(--coral)" }}
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
              Open
            </button>

            <button
              type="button"
              onClick={onShare}
              className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg text-gray-700 font-medium hover:bg-gray-100 transition border border-gray-200"
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
              Share
            </button>

            <button
              type="button"
              onClick={onEdit}
              className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg text-gray-700 font-medium hover:bg-gray-100 transition border border-gray-200"
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
                  d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"
                />
              </svg>
              Edit
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
