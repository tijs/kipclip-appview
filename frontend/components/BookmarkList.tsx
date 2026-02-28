import { useCallback, useEffect, useRef, useState } from "react";
import { AddBookmark } from "./AddBookmark.tsx";
import {
  BookmarkCard,
  getStoredViewMode,
  GridIcon,
  ListIcon,
  shareBookmark,
  storeViewMode,
  type ViewMode,
} from "./BookmarkCard.tsx";
import { BookmarkDetail } from "./BookmarkDetail.tsx";
import { BulkActionToolbar } from "./BulkActionToolbar.tsx";
import { EditBookmark } from "./EditBookmark.tsx";
import { useApp } from "../context/AppContext.tsx";
import type { DateFormatOption } from "../../shared/date-format.ts";
import type { EnrichedBookmark } from "../../shared/types.ts";

export function BookmarkList() {
  const {
    filteredBookmarks: bookmarks,
    totalBookmarks,
    tags: availableTags,
    preferences,
    addBookmark,
    updateBookmark,
    deleteBookmark,
    loadBookmarks: loadBookmarksFromContext,
    loadTags,
    bookmarkSearchQuery,
    setBookmarkSearchQuery,
  } = useApp();
  const dateFormat = preferences.dateFormat as DateFormatOption;

  // Data is pre-loaded by App.tsx via loadInitialData(), so no initial loading state
  const [showAddModal, setShowAddModal] = useState(false);
  const [editingBookmark, setEditingBookmark] = useState<
    EnrichedBookmark | null
  >(null);
  const [detailBookmark, setDetailBookmark] = useState<EnrichedBookmark | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const [dragOverBookmark, setDragOverBookmark] = useState<string | null>(null);
  const [viewMode, setViewModeState] = useState<ViewMode>(getStoredViewMode);
  const [mobileSearchOpen, setMobileSearchOpen] = useState(false);
  const [imageErrors, setImageErrors] = useState<Set<string>>(new Set());

  // Select mode state
  const [isSelectMode, setIsSelectMode] = useState(false);
  const [selectedUris, setSelectedUris] = useState<Set<string>>(new Set());

  const toggleSelection = useCallback((uri: string) => {
    setSelectedUris((prev) => {
      const next = new Set(prev);
      if (next.has(uri)) next.delete(uri);
      else next.add(uri);
      return next;
    });
  }, []);

  function selectAll() {
    setSelectedUris(new Set(bookmarks.map((b) => b.uri)));
  }

  function deselectAll() {
    setSelectedUris(new Set());
  }

  function exitSelectMode() {
    setIsSelectMode(false);
    setSelectedUris(new Set());
  }

  // Escape key exits select mode
  useEffect(() => {
    if (!isSelectMode) return;
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") exitSelectMode();
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [isSelectMode]);

  function setViewMode(mode: ViewMode) {
    setViewModeState(mode);
    storeViewMode(mode);
  }

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
      if (isSelectMode) return;
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
  }, [isPulling, pullDistance, isRefreshing, isSelectMode]);

  // Manual refresh (for pull-to-refresh and retry button)
  async function loadBookmarks() {
    setError(null);
    try {
      await loadBookmarksFromContext();
    } catch (err: any) {
      setError(err.message);
    }
  }

  function handleBookmarkUpdated(bookmark: EnrichedBookmark) {
    updateBookmark(bookmark);
    setEditingBookmark(null);
    // Update detail view if it's showing the same bookmark
    if (detailBookmark?.uri === bookmark.uri) {
      setDetailBookmark(bookmark);
    }
  }

  function handleBookmarkDeleted(uri: string) {
    deleteBookmark(uri);
    setEditingBookmark(null);
    setDetailBookmark(null);
  }

  function handleBookmarkAdded(bookmark: EnrichedBookmark) {
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

  function handleOpenBookmark(bookmark: EnrichedBookmark) {
    globalThis.open(bookmark.subject, "_blank", "noopener,noreferrer");
  }

  function handleImageError(bookmarkUri: string) {
    setImageErrors((prev) => new Set([...prev, bookmarkUri]));
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
        <div className="hidden md:block">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-2xl font-bold text-gray-800">
              Your Bookmarks
              <span className="text-sm font-normal text-gray-500 ml-3">
                {bookmarkSearchQuery.trim()
                  ? `${bookmarks.length} of ${totalBookmarks}`
                  : bookmarks.length}{" "}
                {bookmarks.length === 1 ? "bookmark" : "bookmarks"}
              </span>
            </h2>
            <div className="flex items-center gap-2">
              {bookmarks.length > 0 && (
                <button
                  type="button"
                  onClick={isSelectMode ? exitSelectMode : () => setIsSelectMode(true)}
                  className={`px-3 py-2 text-sm rounded-md border ${
                    isSelectMode
                      ? "border-gray-300 text-gray-700 hover:bg-gray-50"
                      : "border-gray-300 text-gray-700 hover:bg-gray-50"
                  }`}
                >
                  {isSelectMode ? "Cancel" : "Select"}
                </button>
              )}
              {!isSelectMode && (
                <button
                  type="button"
                  onClick={() => setShowAddModal(true)}
                  className="btn-primary"
                >
                  + Add Bookmark
                </button>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <div className="flex items-center border border-gray-300 rounded-lg overflow-hidden">
              <button
                type="button"
                onClick={() => setViewMode("cards")}
                className={`p-2 ${
                  viewMode === "cards" ? "bg-gray-100" : "hover:bg-gray-50"
                }`}
                aria-label="Card view"
              >
                <GridIcon active={viewMode === "cards"} />
              </button>
              <button
                type="button"
                onClick={() => setViewMode("list")}
                className={`p-2 ${
                  viewMode === "list" ? "bg-gray-100" : "hover:bg-gray-50"
                }`}
                aria-label="List view"
              >
                <ListIcon active={viewMode === "list"} />
              </button>
            </div>
            <input
              type="text"
              placeholder="Search bookmarks..."
              value={bookmarkSearchQuery}
              onChange={(e) => setBookmarkSearchQuery(e.target.value)}
              className="flex-1 px-4 py-2 rounded-lg border border-gray-300 focus:ring-2 focus:ring-coral focus:border-transparent outline-none transition"
            />
          </div>
        </div>

        {/* Mobile: stacked layout with expandable search */}
        <div className="md:hidden">
          {mobileSearchOpen
            ? (
              <div className="flex items-center gap-2 mb-2">
                <input
                  type="text"
                  placeholder="Search bookmarks..."
                  value={bookmarkSearchQuery}
                  onChange={(e) => setBookmarkSearchQuery(e.target.value)}
                  className="flex-1 px-3 py-2 rounded-lg border border-gray-300 focus:ring-2 focus:ring-coral focus:border-transparent outline-none"
                  autoFocus
                />
                <button
                  type="button"
                  onClick={() => {
                    setMobileSearchOpen(false);
                    setBookmarkSearchQuery("");
                  }}
                  className="p-2 text-gray-500 hover:text-gray-700"
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
              </div>
            )
            : (
              <div className="flex items-center justify-between mb-2">
                <h2 className="text-2xl font-bold text-gray-800">
                  {isSelectMode ? "Select Bookmarks" : "Your Bookmarks"}
                </h2>
                <div className="flex items-center gap-1">
                  {isSelectMode
                    ? (
                      <button
                        type="button"
                        onClick={exitSelectMode}
                        className="px-3 py-2 text-sm text-gray-700"
                      >
                        Cancel
                      </button>
                    )
                    : (
                      <>
                        <button
                          type="button"
                          onClick={() =>
                            setViewMode(
                              viewMode === "cards" ? "list" : "cards",
                            )}
                          className="p-2 text-gray-500 hover:text-gray-700"
                          aria-label="Toggle view"
                        >
                          {viewMode === "cards"
                            ? <ListIcon active={false} />
                            : <GridIcon active={false} />}
                        </button>
                        <button
                          type="button"
                          onClick={() => setMobileSearchOpen(true)}
                          className="p-2 text-gray-500 hover:text-gray-700"
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
                              d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
                            />
                          </svg>
                        </button>
                        {bookmarks.length > 0 && (
                          <button
                            type="button"
                            onClick={() => setIsSelectMode(true)}
                            className="p-2 text-gray-500 hover:text-gray-700"
                            aria-label="Select bookmarks"
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
                                d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4"
                              />
                            </svg>
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => setShowAddModal(true)}
                          className="px-3 py-2 text-sm rounded-md"
                          style={{
                            backgroundColor: "var(--coral)",
                            color: "white",
                          }}
                        >
                          + Add
                        </button>
                      </>
                    )}
                </div>
              </div>
            )}
          <p className="text-sm text-gray-500">
            {bookmarkSearchQuery.trim()
              ? `${bookmarks.length} of ${totalBookmarks}`
              : bookmarks.length}{" "}
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
          <div
            className={viewMode === "cards"
              ? "grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4"
              : "flex flex-col gap-2"}
          >
            {bookmarks.map((bookmark) => (
              <BookmarkCard
                key={bookmark.uri}
                bookmark={bookmark}
                viewMode={viewMode}
                isDragOver={dragOverBookmark === bookmark.uri}
                imageError={imageErrors.has(bookmark.uri)}
                dateFormat={dateFormat}
                isSelectMode={isSelectMode}
                isSelected={selectedUris.has(bookmark.uri)}
                onClick={isSelectMode
                  ? () => toggleSelection(bookmark.uri)
                  : () => setDetailBookmark(bookmark)}
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
                onImageError={() => handleImageError(bookmark.uri)}
              />
            ))}
          </div>
        )}

      {showAddModal && (
        <AddBookmark
          onClose={() => setShowAddModal(false)}
          onBookmarkAdded={handleBookmarkAdded}
          availableTags={availableTags}
          onTagsChanged={loadTags}
        />
      )}

      {detailBookmark && !editingBookmark && (
        <BookmarkDetail
          bookmark={detailBookmark}
          onClose={() => setDetailBookmark(null)}
          onEdit={() => setEditingBookmark(detailBookmark)}
          onShare={() => shareBookmark(detailBookmark)}
          onOpen={() => handleOpenBookmark(detailBookmark)}
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

      {isSelectMode && selectedUris.size > 0 && (
        <BulkActionToolbar
          selectedCount={selectedUris.size}
          totalCount={bookmarks.length}
          selectedUris={selectedUris}
          bookmarks={bookmarks}
          availableTags={availableTags}
          onSelectAll={selectAll}
          onDeselectAll={deselectAll}
          onComplete={(deletedUris, updatedBookmarks) => {
            for (const uri of deletedUris) deleteBookmark(uri);
            for (const b of updatedBookmarks) updateBookmark(b);
            loadTags();
            exitSelectMode();
          }}
          onPartialFailure={(deletedUris, updatedBookmarks, failedUris) => {
            for (const uri of deletedUris) deleteBookmark(uri);
            for (const b of updatedBookmarks) updateBookmark(b);
            loadTags();
            // Keep only failed URIs selected
            setSelectedUris(new Set(failedUris));
          }}
        />
      )}
    </div>
  );
}
