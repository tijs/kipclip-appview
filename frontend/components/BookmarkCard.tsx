import { type DateFormatOption, formatDate } from "../../shared/date-format.ts";
import type { EnrichedBookmark } from "../../shared/types.ts";

type ViewMode = "cards" | "list";

export function getStoredViewMode(): ViewMode {
  try {
    const stored = localStorage.getItem("kipclip-view-mode");
    if (stored === "cards" || stored === "list") return stored;
  } catch { /* ignore */ }
  return "cards";
}

export function storeViewMode(mode: ViewMode) {
  try {
    localStorage.setItem("kipclip-view-mode", mode);
  } catch { /* ignore */ }
}

export const GridIcon = ({ active }: { active: boolean }) => (
  <svg
    className={`w-4 h-4 ${active ? "text-gray-800" : "text-gray-400"}`}
    fill="none"
    stroke="currentColor"
    viewBox="0 0 24 24"
  >
    <path
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={2}
      d="M4 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2V6zm10 0a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2V6zM4 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2v-2zm10 0a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2v-2z"
    />
  </svg>
);

export const ListIcon = ({ active }: { active: boolean }) => (
  <svg
    className={`w-4 h-4 ${active ? "text-gray-800" : "text-gray-400"}`}
    fill="none"
    stroke="currentColor"
    viewBox="0 0 24 24"
  >
    <path
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={2}
      d="M4 6h16M4 12h16M4 18h16"
    />
  </svg>
);

interface BookmarkCardProps {
  bookmark: EnrichedBookmark;
  viewMode: ViewMode;
  isDragOver: boolean;
  imageError: boolean;
  dateFormat?: DateFormatOption;
  onClick: () => void;
  onDragOver: (e: React.DragEvent) => void;
  onDragEnter: (e: React.DragEvent) => void;
  onDragLeave: (e: React.DragEvent) => void;
  onDrop: (e: React.DragEvent) => void;
  onImageError: () => void;
}

const NoteIcon = () => (
  <svg
    className="w-3.5 h-3.5 text-amber-500 shrink-0"
    fill="none"
    stroke="currentColor"
    viewBox="0 0 24 24"
    aria-label="Has note"
  >
    <path
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={2}
      d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"
    />
  </svg>
);

function getTitle(bookmark: EnrichedBookmark): string {
  try {
    return bookmark.title || new URL(bookmark.subject).hostname;
  } catch {
    return bookmark.subject;
  }
}

function CardView(
  { bookmark, imageError, onImageError, dateFormat }: {
    bookmark: EnrichedBookmark;
    imageError: boolean;
    onImageError: () => void;
    dateFormat?: DateFormatOption;
  },
) {
  return (
    <>
      {bookmark.image && !imageError && (
        <div className="mb-3 -m-4 mt-0">
          <img
            src={bookmark.image}
            alt={getTitle(bookmark)}
            loading="lazy"
            onError={onImageError}
            className="w-full h-48 object-cover rounded-t-lg"
          />
        </div>
      )}

      <div className="mb-3">
        <h3 className="font-semibold text-gray-800 truncate mb-1">
          {getTitle(bookmark)}
        </h3>
        <div className="text-sm text-gray-500 truncate">
          {bookmark.subject}
        </div>
      </div>

      <div className="flex items-center gap-2 text-xs text-gray-400">
        <span>{formatDate(bookmark.createdAt, dateFormat)}</span>
        {bookmark.note && <NoteIcon />}
      </div>

      {bookmark.tags && bookmark.tags.length > 0 && (
        <div className="flex flex-wrap gap-1 mt-2">
          {bookmark.tags.map((tag, i) => (
            <span
              key={i}
              className="px-2 py-1 text-xs rounded-full bg-gray-100 text-gray-700"
            >
              {tag}
            </span>
          ))}
        </div>
      )}
    </>
  );
}

function ListView(
  { bookmark, dateFormat }: {
    bookmark: EnrichedBookmark;
    dateFormat?: DateFormatOption;
  },
) {
  return (
    <div className="flex items-center gap-3 min-w-0">
      {bookmark.favicon
        ? (
          <img
            src={bookmark.favicon}
            alt=""
            className="w-5 h-5 shrink-0 rounded"
            onError={(e) => {
              (e.target as HTMLImageElement).style.display = "none";
            }}
          />
        )
        : <div className="w-5 h-5 shrink-0 rounded bg-gray-200" />}

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 min-w-0">
          <h3 className="font-medium text-gray-800 truncate text-sm">
            {getTitle(bookmark)}
          </h3>
          {bookmark.note && <NoteIcon />}
        </div>
        <div className="text-xs text-gray-400 truncate">
          {bookmark.subject}
        </div>
      </div>

      {bookmark.tags && bookmark.tags.length > 0 && (
        <div className="hidden sm:flex items-center gap-1 shrink-0">
          {bookmark.tags.slice(0, 3).map((tag, i) => (
            <span
              key={i}
              className="px-1.5 py-0.5 text-xs rounded-full bg-gray-100 text-gray-600"
            >
              {tag}
            </span>
          ))}
          {bookmark.tags.length > 3 && (
            <span className="text-xs text-gray-400">
              +{bookmark.tags.length - 3}
            </span>
          )}
        </div>
      )}

      <span className="text-xs text-gray-400 shrink-0 hidden sm:block">
        {formatDate(bookmark.createdAt, dateFormat)}
      </span>
    </div>
  );
}

export function BookmarkCard(
  {
    bookmark,
    viewMode,
    isDragOver,
    imageError,
    dateFormat,
    onClick,
    onDragOver,
    onDragEnter,
    onDragLeave,
    onDrop,
    onImageError,
  }: BookmarkCardProps,
) {
  const dragOverClass = isDragOver ? "border-2 border-blue-500 bg-blue-50" : "";

  const className = viewMode === "cards"
    ? `card transition-all cursor-pointer relative ${dragOverClass}`
    : `px-4 py-3 bg-white rounded-lg border border-gray-200 transition-all cursor-pointer hover:bg-gray-50 ${dragOverClass}`;

  return (
    <div
      data-bookmark-card
      className={className}
      onClick={onClick}
      onDragOver={onDragOver}
      onDragEnter={onDragEnter}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {viewMode === "cards"
        ? (
          <CardView
            bookmark={bookmark}
            imageError={imageError}
            onImageError={onImageError}
            dateFormat={dateFormat}
          />
        )
        : <ListView bookmark={bookmark} dateFormat={dateFormat} />}
    </div>
  );
}

export async function shareBookmark(bookmark: EnrichedBookmark) {
  const title = bookmark.title ||
    (() => {
      try {
        return new URL(bookmark.subject).hostname;
      } catch {
        return bookmark.subject;
      }
    })();

  const shareData = {
    title,
    text: bookmark.description ? `${title}\n\n${bookmark.description}` : title,
    url: bookmark.subject,
  };

  if (navigator.share) {
    try {
      await navigator.share(shareData);
    } catch (err: any) {
      if (err.name !== "AbortError") {
        console.error("Share failed:", err);
      }
    }
  } else {
    try {
      await navigator.clipboard.writeText(
        `${shareData.title}\n${shareData.text}\n${shareData.url}`,
      );
      alert("Link copied to clipboard!");
    } catch (err) {
      console.error("Failed to copy:", err);
      alert("Sharing not supported on this browser");
    }
  }
}

export type { ViewMode };
