import { useMemo, useState } from "react";
import { toast } from "sonner";
import { AddTag } from "./AddTag.tsx";
import { EditTag } from "./EditTag.tsx";
import { useApp } from "../context/AppContext.tsx";
import { useDateFormat } from "../hooks/useDateFormat.ts";
import { encodeTagsForUrl } from "../../shared/utils.ts";
import { Button } from "./Button.tsx";

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
    recentTags,
    session,
  } = useApp();
  const formatDate = useDateFormat();

  // Data is pre-loaded by App.tsx via loadInitialData(), so no initial loading state
  const [showAddModal, setShowAddModal] = useState(false);
  const [editingTag, setEditingTag] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");

  const trimmedQuery = searchQuery.trim().toLowerCase();
  const isSearching = trimmedQuery.length > 0;

  const filteredTags = useMemo(() => {
    if (!isSearching) return tags;
    return tags.filter((t) => t.value.toLowerCase().includes(trimmedQuery));
  }, [tags, trimmedQuery, isSearching]);

  // Resolve recent tag strings to live EnrichedTag objects, dropping any
  // entries whose tag was deleted from the user's library.
  const recentTagObjects = useMemo(() => {
    if (isSearching || recentTags.length === 0) return [];
    const byLower = new Map(tags.map((t) => [t.value.toLowerCase(), t]));
    const resolved: typeof tags = [];
    for (const v of recentTags) {
      const match = byLower.get(v.toLowerCase());
      if (match) resolved.push(match);
    }
    return resolved;
  }, [tags, recentTags, isSearching]);

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
    toast("Tag created");
  }

  function handleTagUpdated(updatedTag: any) {
    updateTag(updatedTag);
    setEditingTag(null);
    toast("Tag updated");
  }

  function handleTagDeleted(tagUri: string) {
    deleteTag(tagUri);
    setEditingTag(null);
    toast("Tag deleted");
  }

  function handleShareFiltered() {
    if (!session || selectedTags.size === 0) return;

    // Look up original-case tag values for the share URL
    const originalCaseTags = tags
      .filter((t) => selectedTags.has(t.value.toLowerCase()))
      .map((t) => t.value);
    const encodedTags = encodeTagsForUrl(originalCaseTags);
    globalThis.location.href = `/share/${session.did}/${encodedTags}`;
  }

  // Shared tag item renderer
  function renderTag(tag: any) {
    const isSelected = selectedTags.has(tag.value.toLowerCase());
    return (
      <li
        key={tag.uri}
        className={`group flex items-center justify-between gap-2 px-3 py-2 rounded-lg transition text-sm whitespace-nowrap flex-shrink-0 md:min-w-0 cursor-pointer ${
          isSelected ? "coral-selected" : "text-gray-700 hover:bg-gray-100"
        }`}
        title={`Created ${formatDate(tag.createdAt)}`}
        onClick={() => {
          toggleTag(tag.value);
        }}
      >
        <div className="flex items-center gap-2 min-w-0">
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
          <span className="md:truncate">{tag.value}</span>
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setEditingTag(tag);
            }}
            className={`opacity-0 group-hover:opacity-100 transition p-1 rounded flex-shrink-0 ${
              isSelected ? "hover:bg-gray-200/30" : "hover:bg-gray-200"
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
              isSelected ? "hover:bg-gray-200/30" : "hover:bg-gray-200"
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
        {/* Tag scroll row */}
        <div className="flex items-center gap-2 px-3 py-2 overflow-x-auto tag-scroll-fade">
          <h2 className="text-sm font-bold text-gray-800 flex-shrink-0">
            Tags
            <span className="font-normal text-gray-500 ml-1">
              ({tags.length})
            </span>
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
            : isSearching && filteredTags.length === 0
            ? (
              <div className="flex-1 text-xs text-gray-500 flex-shrink-0">
                No matches
              </div>
            )
            : (
              <ul className="flex gap-2 flex-shrink-0 items-center">
                {!isSearching && recentTagObjects.map(renderTag)}
                {!isSearching && recentTagObjects.length > 0 &&
                  filteredTags.length > 0 && (
                  <li
                    aria-hidden="true"
                    className="border-l border-gray-300 h-6 mx-1 flex-shrink-0"
                  />
                )}
                {filteredTags.map(renderTag)}
              </ul>
            )}
          <button
            type="button"
            onClick={() => setShowAddModal(true)}
            className="flex-shrink-0 ml-auto p-1.5 hover:bg-gray-100 rounded-lg transition text-gray-600 min-w-[44px] min-h-[44px] flex items-center justify-center"
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
        {/* Search row */}
        {tags.length > 0 && (
          <div className="relative px-3 pb-2">
            <svg
              className="w-4 h-4 absolute left-4 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M21 21l-4.35-4.35M17 11a6 6 0 11-12 0 6 6 0 0112 0z"
              />
            </svg>
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") setSearchQuery("");
              }}
              placeholder="Search tags"
              aria-label="Search tags"
              className="w-full bg-transparent border-0 border-b border-gray-300 focus:border-coral outline-none pl-7 pr-1 py-1.5 text-sm placeholder-gray-400"
            />
          </div>
        )}
        {/* Action row: appears when tags are selected */}
        {selectedTags.size > 0 && (
          <div className="flex items-center gap-2 px-3 py-2 border-t border-gray-100">
            <span className="text-xs text-gray-500 flex-shrink-0">
              {selectedTags.size} {selectedTags.size === 1 ? "tag" : "tags"}
              {" "}
              selected
            </span>
            <div className="flex items-center gap-2 ml-auto">
              <button
                type="button"
                onClick={clearFilters}
                className="px-3 py-1.5 text-xs bg-gray-200 hover:bg-gray-300 rounded-lg transition text-gray-700 font-medium"
                title="Clear all filters"
              >
                Clear
              </button>
              <button
                type="button"
                onClick={handleShareFiltered}
                className="px-3 py-1.5 text-xs rounded-lg transition text-white font-medium flex items-center gap-1.5"
                style={{ backgroundColor: "var(--coral)" }}
                title="Open the shareable collection page"
              >
                <svg
                  className="w-3.5 h-3.5"
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
          </div>
        )}
      </div>

      {/* Desktop: Vertical sidebar */}
      <aside
        style={{ backgroundColor: "var(--sidebar-bg)" }}
        className="hidden md:flex md:flex-col w-64 border-r border-gray-200 px-4 pt-8 pb-4"
      >
        <div className="mb-4">
          <h2 className="text-2xl font-bold text-gray-800 mb-3">
            Tags
            <span className="text-sm font-normal text-gray-500 ml-3">
              {tags.length} {tags.length === 1 ? "tag" : "tags"}
            </span>
          </h2>
          <Button
            type="button"
            variant="primary"
            size="sm"
            onClick={() => setShowAddModal(true)}
            fullWidth
          >
            + Create Tag
          </Button>
        </div>

        {selectedTags.size > 0 && (
          <div className="mb-4 space-y-2">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={clearFilters}
              title="Clear all filters"
              fullWidth
            >
              Clear filters ({selectedTags.size})
            </Button>
            <Button
              type="button"
              variant="primary"
              size="sm"
              onClick={handleShareFiltered}
              title="Open the shareable collection page"
              fullWidth
              leadingIcon={
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
              }
            >
              Share collection
            </Button>
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

        {tags.length > 0 && (
          <div className="relative mb-3">
            <svg
              className="w-4 h-4 absolute left-1 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M21 21l-4.35-4.35M17 11a6 6 0 11-12 0 6 6 0 0112 0z"
              />
            </svg>
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") setSearchQuery("");
              }}
              placeholder="Search tags"
              aria-label="Search tags"
              className="w-full bg-transparent border-0 border-b border-gray-300 focus:border-coral outline-none pl-7 pr-1 py-2 text-sm placeholder-gray-400"
            />
          </div>
        )}

        <div className="flex-1 overflow-y-auto overflow-x-hidden">
          {tags.length === 0
            ? (
              <div className="text-center py-10 text-gray-500 text-sm">
                <p className="mb-2">No tags yet</p>
                <p className="text-xs">Create your first tag to get started</p>
              </div>
            )
            : isSearching && filteredTags.length === 0
            ? (
              <div className="text-center py-6 text-gray-500 text-xs">
                No tags match "{searchQuery.trim()}"
              </div>
            )
            : (
              <>
                {recentTagObjects.length > 0 && (
                  <section className="mb-2">
                    <h3 className="text-[10px] font-semibold uppercase tracking-wider text-gray-400 px-3 mt-1 mb-2">
                      Recent
                    </h3>
                    <ul className="space-y-1">
                      {recentTagObjects.map(renderTag)}
                    </ul>
                  </section>
                )}
                {recentTagObjects.length > 0 && filteredTags.length > 0 && (
                  <div className="border-t border-gray-200 mx-3 my-3" />
                )}
                <ul className="space-y-1">{filteredTags.map(renderTag)}</ul>
              </>
            )}
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
