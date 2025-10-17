/** @jsxImportSource https://esm.sh/react */
import { useEffect, useState } from "https://esm.sh/react";
import { AddBookmark } from "./AddBookmark.tsx";
import type { EnrichedBookmark } from "../../shared/types.ts";

interface BookmarkListProps {
  bookmarks: EnrichedBookmark[];
  onBookmarksChange: (bookmarks: EnrichedBookmark[]) => void;
}

export function BookmarkList(
  { bookmarks, onBookmarksChange }: BookmarkListProps,
) {
  const [loading, setLoading] = useState(true);
  const [showAddModal, setShowAddModal] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragOverBookmark, setDragOverBookmark] = useState<string | null>(null);

  useEffect(() => {
    loadBookmarks();
  }, []);

  async function loadBookmarks() {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/bookmarks");
      if (!response.ok) {
        throw new Error("Failed to load bookmarks");
      }
      const data = await response.json();
      onBookmarksChange(data.bookmarks);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function handleDeleteBookmark(uri: string) {
    if (!confirm("Are you sure you want to delete this bookmark?")) {
      return;
    }

    try {
      // Extract rkey from URI
      const rkey = uri.split("/").pop();
      const response = await fetch(`/api/bookmarks/${rkey}`, {
        method: "DELETE",
      });

      if (!response.ok) {
        throw new Error("Failed to delete bookmark");
      }

      // Remove from local state
      onBookmarksChange(bookmarks.filter((b) => b.uri !== uri));
    } catch (err: any) {
      alert(`Failed to delete bookmark: ${err.message}`);
    }
  }

  function handleBookmarkAdded(bookmark: EnrichedBookmark) {
    onBookmarksChange([bookmark, ...bookmarks]);
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

      // Update local state
      onBookmarksChange(
        bookmarks.map((b) => b.uri === bookmarkUri ? data.bookmark : b),
      );
    } catch (err: any) {
      console.error("Failed to add tag to bookmark:", err);
      alert(`Failed to add tag: ${err.message}`);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="spinner"></div>
      </div>
    );
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
                className={`card hover:scale-[1.02] transition-all ${
                  dragOverBookmark === bookmark.uri
                    ? "border-2 border-blue-500 bg-blue-50"
                    : ""
                }`}
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
                <div className="flex items-start justify-between mb-3">
                  <div className="flex-1 min-w-0">
                    <h3 className="font-semibold text-gray-800 truncate mb-1">
                      {bookmark.title || new URL(bookmark.subject).hostname}
                    </h3>
                    <a
                      href={bookmark.subject}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-sm text-gray-500 hover:text-blue-600 truncate block"
                    >
                      {bookmark.subject}
                    </a>
                  </div>
                  <button
                    type="button"
                    onClick={() => handleDeleteBookmark(bookmark.uri)}
                    className="text-gray-400 hover:text-red-600 ml-2"
                    title="Delete bookmark"
                  >
                    ×
                  </button>
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
    </div>
  );
}
