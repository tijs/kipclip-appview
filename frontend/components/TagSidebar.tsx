import { useState } from "react";
import { AddTag } from "./AddTag.tsx";
import { EditTag } from "./EditTag.tsx";
import { useApp } from "../context/AppContext.tsx";
import { encodeTagsForUrl } from "../../shared/utils.ts";

export function TagSidebar() {
  const {
    tags,
    selectedTags,
    toggleTag,
    clearFilters,
    loadTags: loadTagsFromContext,
    addTag,
    updateTag,
    deleteTag,
    session,
  } = useApp();

  // Data is pre-loaded by App.tsx via loadInitialData(), so no initial loading state
  const [showAddModal, setShowAddModal] = useState(false);
  const [editingTag, setEditingTag] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  // Manual refresh (for retry button)
  async function loadTags() {
    setRefreshing(true);
    setError(null);
    try {
      await loadTagsFromContext();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setRefreshing(false);
    }
  }

  function handleTagAdded(tag: any) {
    addTag(tag);
    setShowAddModal(false);
  }

  function handleTagUpdated(updatedTag: any) {
    updateTag(updatedTag);
    setEditingTag(null);
  }

  function handleTagDeleted(tagUri: string) {
    deleteTag(tagUri);
    setEditingTag(null);
  }

  async function handleShareFiltered() {
    if (!session || selectedTags.size === 0) return;

    try {
      // Generate share URL
      const encodedTags = encodeTagsForUrl([...selectedTags]);
      const shareUrl =
        `${globalThis.location.origin}/share/${session.did}/${encodedTags}`;

      // Use Web Share API if available
      if (navigator.share) {
        await navigator.share({
          title: "My Kipclip Bookmarks Collection",
          text: `Check out my bookmarks collection tagged with: ${
            [...selectedTags].join(", ")
          }`,
          url: shareUrl,
        });
      } else {
        // Fallback: copy to clipboard
        await navigator.clipboard.writeText(shareUrl);
        alert("Share link copied to clipboard!");
      }
    } catch (err: any) {
      // User cancelled or share failed
      if (err.name !== "AbortError") {
        console.error("Share failed:", err);
        alert("Failed to share link");
      }
    }
  }

  // Shared tag item renderer
  function renderTag(tag: any) {
    const isSelected = selectedTags.has(tag.value);
    return (
      <li
        key={tag.uri}
        className={`group flex items-center justify-between gap-2 px-3 py-2 rounded-lg transition text-sm whitespace-nowrap flex-shrink-0 cursor-pointer ${
          isSelected
            ? "bg-blue-600 text-white hover:bg-blue-700"
            : "text-gray-700 hover:bg-gray-100"
        }`}
        title={`Created ${new Date(tag.createdAt).toLocaleDateString()}`}
        onClick={() => {
          toggleTag(tag.value);
        }}
      >
        <div className="flex items-center gap-2">
          {isSelected && (
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
                d="M5 13l4 4L19 7"
              />
            </svg>
          )}
          <span>{tag.value}</span>
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setEditingTag(tag);
            }}
            className={`opacity-0 group-hover:opacity-100 transition p-1 rounded flex-shrink-0 ${
              isSelected ? "hover:bg-blue-500" : "hover:bg-gray-200"
            }`}
            title="Edit tag"
          >
            <svg
              className={`w-4 h-4 ${
                isSelected ? "text-white" : "text-gray-600"
              }`}
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z"
              />
            </svg>
          </button>
          <button
            type="button"
            draggable="true"
            onClick={(e) => {
              e.stopPropagation();
            }}
            onDragStart={(e) => {
              e.stopPropagation();
              e.dataTransfer.effectAllowed = "copy";
              e.dataTransfer.setData("text/plain", tag.value);
              const listItem = (e.target as HTMLElement).closest("li");
              if (listItem) {
                // Set the drag image to the entire tag card
                e.dataTransfer.setDragImage(listItem, 20, 20);
                listItem.style.opacity = "0.5";
              }
            }}
            onDragEnd={(e) => {
              e.stopPropagation();
              const listItem = (e.target as HTMLElement).closest("li");
              if (listItem) {
                listItem.style.opacity = "1";
              }
            }}
            className={`opacity-0 group-hover:opacity-100 transition p-1 rounded cursor-grab active:cursor-grabbing flex-shrink-0 ${
              isSelected ? "hover:bg-blue-500" : "hover:bg-gray-200"
            }`}
            title="Drag to bookmark to tag it"
          >
            <svg
              className={`w-4 h-4 ${
                isSelected ? "text-white" : "text-gray-600"
              }`}
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M4 8h16M4 16h16"
              />
            </svg>
          </button>
        </div>
      </li>
    );
  }

  return (
    <>
      {/* Mobile: Horizontal sticky bar */}
      <div
        style={{ backgroundColor: "var(--sidebar-bg)" }}
        className="md:hidden w-full sticky top-0 z-10 border-b border-gray-200"
      >
        <div className="flex items-center gap-3 px-3 py-3 overflow-x-auto">
          <h2 className="text-sm font-bold text-gray-800 flex-shrink-0">
            Tags
          </h2>
          {error
            ? (
              <div className="flex-1 text-xs text-red-600 flex-shrink-0">
                {error}
              </div>
            )
            : tags.length === 0
            ? (
              <div className="flex-1 text-xs text-gray-500 flex-shrink-0">
                No tags yet
              </div>
            )
            : (
              <ul className="flex gap-2 flex-shrink-0">
                {tags.map(renderTag)}
              </ul>
            )}
          {selectedTags.size > 0 && (
            <>
              <button
                type="button"
                onClick={clearFilters}
                className="flex-shrink-0 px-3 py-1 text-xs bg-gray-200 hover:bg-gray-300 rounded-lg transition text-gray-700 font-medium"
                title="Clear all filters"
              >
                Clear filters
              </button>
              <button
                type="button"
                onClick={handleShareFiltered}
                className="flex-shrink-0 px-3 py-1 text-xs rounded-lg transition text-white font-medium flex items-center gap-1"
                style={{ backgroundColor: "var(--coral)" }}
                title="Share these filtered bookmarks"
              >
                <svg
                  className="w-3 h-3"
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
            </>
          )}
          <button
            type="button"
            onClick={() => setShowAddModal(true)}
            className="flex-shrink-0 ml-auto p-2 hover:bg-gray-100 rounded-lg transition text-gray-600"
            title="Create tag"
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
                d="M12 4v16m8-8H4"
              />
            </svg>
          </button>
        </div>
      </div>

      {/* Desktop: Vertical sidebar */}
      <aside
        style={{ backgroundColor: "var(--sidebar-bg)" }}
        className="hidden md:flex md:flex-col w-64 border-r border-gray-200 p-4"
      >
        <div className="mb-4">
          <h2 className="text-lg font-bold text-gray-800 mb-3">Tags</h2>
          <button
            type="button"
            onClick={() => setShowAddModal(true)}
            className="w-full btn-primary text-sm py-2 px-4"
          >
            + Create Tag
          </button>
        </div>

        {selectedTags.size > 0 && (
          <div className="mb-4 space-y-2">
            <button
              type="button"
              onClick={clearFilters}
              className="w-full px-3 py-2 text-sm bg-gray-200 hover:bg-gray-300 rounded-lg transition text-gray-700 font-medium"
              title="Clear all filters"
            >
              Clear filters ({selectedTags.size})
            </button>
            <button
              type="button"
              onClick={handleShareFiltered}
              className="w-full px-3 py-2 text-sm rounded-lg transition text-white font-medium flex items-center justify-center gap-2"
              style={{ backgroundColor: "var(--coral)" }}
              title="Share these filtered bookmarks"
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
              Share collection
            </button>
          </div>
        )}

        {error && (
          <div className="bg-red-50 border border-red-200 text-red-700 px-3 py-2 rounded text-xs mb-4">
            {error}
            <button
              type="button"
              onClick={() => loadTags()}
              disabled={refreshing}
              className="block mt-2 underline disabled:opacity-50"
            >
              {refreshing ? "Loading..." : "Try Again"}
            </button>
          </div>
        )}

        <div className="flex-1 overflow-y-auto">
          {tags.length === 0
            ? (
              <div className="text-center py-10 text-gray-500 text-sm">
                <p className="mb-2">No tags yet</p>
                <p className="text-xs">Create your first tag to get started</p>
              </div>
            )
            : <ul className="space-y-1">{tags.map(renderTag)}</ul>}
        </div>
      </aside>

      {showAddModal && (
        <AddTag
          onClose={() => setShowAddModal(false)}
          onTagAdded={handleTagAdded}
        />
      )}

      {editingTag && (
        <EditTag
          tag={editingTag}
          onClose={() => setEditingTag(null)}
          onTagUpdated={handleTagUpdated}
          onTagDeleted={handleTagDeleted}
        />
      )}
    </>
  );
}
