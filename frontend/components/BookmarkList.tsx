import { useEffect, useRef, useState } from "react";
import { AddBookmark } from "./AddBookmark.tsx";
import { EditBookmark } from "./EditBookmark.tsx";
import { useApp } from "../context/AppContext.tsx";

export function BookmarkList() {
  const {
    filteredBookmarks: bookmarks,
    tags: availableTags,
    addBookmark,
    updateBookmark,
    deleteBookmark,
    loadBookmarks: loadBookmarksFromContext,
    loadTags,
  } = useApp();

  // Data is pre-loaded by App.tsx via loadInitialData(), so no initial loading state
  const [showAddModal, setShowAddModal] = useState(false);
  const [editingBookmark, setEditingBookmark] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragOverBookmark, setDragOverBookmark] = useState<string | null>(null);

  // Pull-to-refresh state
  const [pullDistance, setPullDistance] = useState(0);
  const [isPulling, setIsPulling] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const touchStartY = useRef(0);

  // Pull-to-refresh touch handlers
  useEffect(() => {
    function isAtTop(): boolean {
      // Check both window scroll and main element scroll for PWA compatibility
      const mainElement = document.querySelector("main");
      const windowAtTop = globalThis.scrollY === 0;
      const mainAtTop = !mainElement || mainElement.scrollTop === 0;
      return windowAtTop && mainAtTop;
    }

    function handleTouchStart(e: TouchEvent) {
      // Only start pull if scrolled to top
      if (isAtTop()) {
        touchStartY.current = e.touches[0].clientY;
        setIsPulling(true);
      }
    }

    function handleTouchMove(e: TouchEvent) {
      if (!isPulling || isRefreshing) return;

      const touchY = e.touches[0].clientY;
      const distance = touchY - touchStartY.current;

      // Only pull down, and limit distance
      if (distance > 0 && isAtTop()) {
        e.preventDefault();
        setPullDistance(Math.min(distance, 120));
      }
    }

    function handleTouchEnd() {
      if (!isPulling) return;

      setIsPulling(false);

      // Trigger refresh if pulled far enough
      if (pullDistance > 80) {
        setIsRefreshing(true);
        loadBookmarks().finally(() => {
          setIsRefreshing(false);
          setPullDistance(0);
        });
      } else {
        setPullDistance(0);
      }
    }

    // Listen on document level to catch all touch events
    document.addEventListener("touchstart", handleTouchStart, {
      passive: true,
    });
    document.addEventListener("touchmove", handleTouchMove, {
      passive: false,
    });
    document.addEventListener("touchend", handleTouchEnd);

    return () => {
      document.removeEventListener("touchstart", handleTouchStart);
      document.removeEventListener("touchmove", handleTouchMove);
      document.removeEventListener("touchend", handleTouchEnd);
    };
  }, [isPulling, pullDistance, isRefreshing]);

  // Manual refresh (for pull-to-refresh and retry button)
  async function loadBookmarks() {
    setError(null);
    try {
      await loadBookmarksFromContext();
    } catch (err: any) {
      setError(err.message);
    }
  }

  function handleBookmarkUpdated(bookmark: any) {
    updateBookmark(bookmark);
    setEditingBookmark(null);
  }

  function handleBookmarkDeleted(uri: string) {
    deleteBookmark(uri);
    setEditingBookmark(null);
  }

  function handleBookmarkAdded(bookmark: any) {
    addBookmark(bookmark);
    setShowAddModal(false);
  }

  async function handleDropTag(bookmarkUri: string, tagValue: string) {
    try {
      // Extract rkey from URI
      const rkey = bookmarkUri.split("/").pop();
      if (!rkey) {
        throw new Error("Invalid bookmark URI");
      }

      // Find the bookmark
      const bookmark = bookmarks.find((b) => b.uri === bookmarkUri);
      if (!bookmark) {
        throw new Error("Bookmark not found");
      }

      // Check if tag already exists
      if (bookmark.tags?.includes(tagValue)) {
        return; // Skip if already tagged
      }

      // Add tag to existing tags
      const newTags = [...(bookmark.tags || []), tagValue];

      // Update via API
      const response = await fetch(`/api/bookmarks/${rkey}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ tags: newTags }),
      });

      if (!response.ok) {
        throw new Error("Failed to update bookmark tags");
      }

      const data = await response.json();

      // Update context state
      updateBookmark(data.bookmark);
    } catch (err: any) {
      console.error("Failed to add tag to bookmark:", err);
      alert(`Failed to add tag: ${err.message}`);
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

  if (error) {
    return (
      <div className="text-center py-20">
        <p className="text-red-600 mb-4">Error: {error}</p>
        <button type="button" onClick={loadBookmarks} className="btn-primary">
          Try Again
        </button>
      </div>
    );
  }

  return (
    <div className="fade-in">
      {/* Pull-to-refresh indicator */}
      <div
        style={{
          position: "fixed",
          top: 0,
          left: 0,
          right: 0,
          height: `${pullDistance}px`,
          display: pullDistance > 0 ? "flex" : "none",
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: "var(--coral)",
          color: "white",
          zIndex: 40,
          transition: isPulling ? "none" : "height 0.3s ease-out",
        }}
      >
        {isRefreshing
          ? (
            <div
              className="spinner"
              style={{
                borderColor: "white transparent transparent transparent",
              }}
            >
            </div>
          )
          : (
            <span style={{ fontSize: "24px" }}>
              {pullDistance > 80 ? "↓" : "↑"}
            </span>
          )}
      </div>

      <div className="mb-6">
        {/* Desktop: side-by-side layout */}
        <div className="hidden md:flex items-center justify-between">
          <h2 className="text-2xl font-bold text-gray-800">
            Your Bookmarks
            <span className="text-sm font-normal text-gray-500 ml-3">
              {bookmarks.length}{" "}
              {bookmarks.length === 1 ? "bookmark" : "bookmarks"}
            </span>
          </h2>
          <button
            type="button"
            onClick={() => setShowAddModal(true)}
            className="btn-primary"
          >
            + Add Bookmark
          </button>
        </div>

        {/* Mobile: stacked layout */}
        <div className="md:hidden">
          <div className="flex items-center justify-between mb-2">
            <h2 className="text-2xl font-bold text-gray-800">
              Your Bookmarks
            </h2>
            <button
              type="button"
              onClick={() => setShowAddModal(true)}
              className="px-3 py-2 text-sm rounded-md"
              style={{ backgroundColor: "var(--coral)", color: "white" }}
            >
              + Add
            </button>
          </div>
          <p className="text-sm text-gray-500">
            {bookmarks.length}{" "}
            {bookmarks.length === 1 ? "bookmark" : "bookmarks"}
          </p>
        </div>
      </div>

      {bookmarks.length === 0
        ? (
          <div className="text-center py-20">
            <div className="mb-6">
              <span className="text-6xl">📚</span>
            </div>
            <h3 className="text-xl font-semibold text-gray-700 mb-2">
              No bookmarks yet
            </h3>
            <p className="text-gray-500 mb-6">
              Start collecting your favorite links!
            </p>
            <button
              type="button"
              onClick={() => setShowAddModal(true)}
              className="btn-primary"
            >
              Add Your First Bookmark
            </button>
          </div>
        )
        : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {bookmarks.map((bookmark) => (
              <div
                key={bookmark.uri}
                className={`card hover:scale-[1.02] transition-all cursor-pointer group relative ${
                  dragOverBookmark === bookmark.uri
                    ? "border-2 border-blue-500 bg-blue-50"
                    : ""
                }`}
                onClick={() => setEditingBookmark(bookmark)}
                onDragOver={(e) => {
                  e.preventDefault();
                  e.dataTransfer.dropEffect = "copy";
                }}
                onDragEnter={(e) => {
                  e.preventDefault();
                  setDragOverBookmark(bookmark.uri);
                }}
                onDragLeave={(e) => {
                  e.preventDefault();
                  // Only clear if we're leaving the card itself, not a child
                  if (e.currentTarget === e.target) {
                    setDragOverBookmark(null);
                  }
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  setDragOverBookmark(null);
                  const tagValue = e.dataTransfer.getData("text/plain");
                  if (tagValue) {
                    handleDropTag(bookmark.uri, tagValue);
                  }
                }}
              >
                <div className="mb-3">
                  <h3 className="font-semibold text-gray-800 truncate mb-1">
                    {bookmark.title || new URL(bookmark.subject).hostname}
                  </h3>
                  <div className="text-sm text-gray-500 truncate">
                    {bookmark.subject}
                  </div>
                </div>

                <div className="text-xs text-gray-400">
                  {new Date(bookmark.createdAt).toLocaleDateString()}
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

      {showAddModal && (
        <AddBookmark
          onClose={() => setShowAddModal(false)}
          onBookmarkAdded={handleBookmarkAdded}
        />
      )}

      {editingBookmark && (
        <EditBookmark
          bookmark={editingBookmark}
          availableTags={availableTags}
          onClose={() => setEditingBookmark(null)}
          onBookmarkUpdated={handleBookmarkUpdated}
          onBookmarkDeleted={handleBookmarkDeleted}
          onTagsChanged={loadTags}
        />
      )}
    </div>
  );
}
