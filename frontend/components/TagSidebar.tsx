/** @jsxImportSource https://esm.sh/react */
import { useEffect, useState } from "https://esm.sh/react";
import { AddTag } from "./AddTag.tsx";
import { EditTag } from "./EditTag.tsx";
import type { EnrichedTag } from "../../shared/types.ts";

interface TagSidebarProps {
  isOpen: boolean;
  onToggle: () => void;
}

export function TagSidebar({ isOpen, onToggle }: TagSidebarProps) {
  const [tags, setTags] = useState<EnrichedTag[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAddModal, setShowAddModal] = useState(false);
  const [editingTag, setEditingTag] = useState<EnrichedTag | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadTags();
  }, []);

  async function loadTags(retryCount = 0) {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/tags");
      if (!response.ok) {
        // If we get a 503 (service unavailable), retry after a brief delay
        if (response.status === 503 && retryCount < 3) {
          await new Promise((resolve) =>
            setTimeout(resolve, 300 * (retryCount + 1))
          );
          return loadTags(retryCount + 1);
        }
        throw new Error("Failed to load tags");
      }
      const data = await response.json();
      setTags(data.tags);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  function handleTagAdded(tag: EnrichedTag) {
    setTags([tag, ...tags]);
    setShowAddModal(false);
  }

  function handleTagUpdated(updatedTag: EnrichedTag) {
    setTags(tags.map((t) => t.uri === updatedTag.uri ? updatedTag : t));
    setEditingTag(null);
  }

  function handleTagDeleted(tagUri: string) {
    setTags(tags.filter((t) => t.uri !== tagUri));
    setEditingTag(null);
  }

  if (loading) {
    return (
      <aside
        style={{ backgroundColor: "var(--sidebar-bg)" }}
        className={`
          transition-all duration-300 relative flex-shrink-0
          ${isOpen ? "w-full md:w-64" : "w-full md:w-12"}
          ${isOpen ? "h-auto" : "h-12"}
          md:h-full
          ${isOpen ? "p-4" : "p-0"}
          md:border-r border-b md:border-b-0 border-gray-200
          overflow-hidden
        `}
      >
        <button
          type="button"
          onClick={onToggle}
          className={`
            absolute p-2 hover:bg-gray-100 rounded-lg transition z-10
            md:top-4 md:right-4 top-2 left-2
          `}
          title={isOpen ? "Hide tags" : "Show tags"}
        >
          <svg
            className="w-5 h-5 text-gray-600"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <rect
              x="3"
              y="3"
              width="18"
              height="18"
              rx="2"
              strokeWidth={2}
              className="hidden md:block"
            />
            <line
              x1="9"
              y1="3"
              x2="9"
              y2="21"
              strokeWidth={2}
              className="hidden md:block"
            />
            {isOpen && (
              <rect
                x="4"
                y="4"
                width="4"
                height="16"
                fill="currentColor"
                className="hidden md:block"
              />
            )}
            <rect
              x="3"
              y="3"
              width="18"
              height="18"
              rx="2"
              strokeWidth={2}
              className="md:hidden"
            />
            <line
              x1="3"
              y1="9"
              x2="21"
              y2="9"
              strokeWidth={2}
              className="md:hidden"
            />
            {isOpen && (
              <rect
                x="4"
                y="4"
                width="16"
                height="4"
                fill="currentColor"
                className="md:hidden"
              />
            )}
          </svg>
        </button>
        {isOpen && (
          <div className="flex items-center justify-center py-10">
            <div className="spinner"></div>
          </div>
        )}
      </aside>
    );
  }

  return (
    <aside
      style={{ backgroundColor: "var(--sidebar-bg)" }}
      className={`
        transition-all duration-300 relative flex-shrink-0
        ${isOpen ? "w-full md:w-64" : "w-full md:w-12"}
        ${isOpen ? "h-auto" : "h-12"}
        md:h-full
        ${isOpen ? "p-4" : "p-0"}
        md:border-r border-b md:border-b-0 border-gray-200
        overflow-hidden md:flex md:flex-col
      `}
    >
      {isOpen && (
        <div className="mb-4">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-lg font-bold text-gray-800 flex items-center gap-2">
              <button
                type="button"
                onClick={onToggle}
                className="md:hidden p-2 hover:bg-gray-100 rounded-lg transition"
                title="Hide tags"
              >
                <svg
                  className="w-5 h-5 text-gray-600"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <rect
                    x="3"
                    y="3"
                    width="18"
                    height="18"
                    rx="2"
                    strokeWidth={2}
                  />
                  <line x1="3" y1="9" x2="21" y2="9" strokeWidth={2} />
                  <rect
                    x="4"
                    y="4"
                    width="16"
                    height="4"
                    fill="currentColor"
                  />
                </svg>
              </button>
              <span>Tags</span>
            </h2>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setShowAddModal(true)}
                className="md:hidden p-2 hover:bg-gray-100 rounded-lg transition text-gray-600"
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
              <button
                type="button"
                onClick={onToggle}
                className="hidden md:block p-2 hover:bg-gray-100 rounded-lg transition"
                title="Hide tags"
              >
                <svg
                  className="w-5 h-5 text-gray-600"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <rect
                    x="3"
                    y="3"
                    width="18"
                    height="18"
                    rx="2"
                    strokeWidth={2}
                  />
                  <line x1="9" y1="3" x2="9" y2="21" strokeWidth={2} />
                  <rect
                    x="4"
                    y="4"
                    width="4"
                    height="16"
                    fill="currentColor"
                  />
                </svg>
              </button>
            </div>
          </div>
          <button
            type="button"
            onClick={() => setShowAddModal(true)}
            className="hidden md:block w-full btn-primary text-sm py-2 px-4"
          >
            + Create Tag
          </button>
        </div>
      )}
      {!isOpen && (
        <button
          type="button"
          onClick={onToggle}
          className="p-2 hover:bg-gray-100 rounded-lg transition md:absolute md:top-4 md:left-2 m-2"
          title="Show tags"
        >
          <svg
            className="w-5 h-5 text-gray-600"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <rect
              x="3"
              y="3"
              width="18"
              height="18"
              rx="2"
              strokeWidth={2}
              className="hidden md:block"
            />
            <line
              x1="9"
              y1="3"
              x2="9"
              y2="21"
              strokeWidth={2}
              className="hidden md:block"
            />
            <rect
              x="3"
              y="3"
              width="18"
              height="18"
              rx="2"
              strokeWidth={2}
              className="md:hidden"
            />
            <line
              x1="3"
              y1="9"
              x2="21"
              y2="9"
              strokeWidth={2}
              className="md:hidden"
            />
          </svg>
        </button>
      )}

      {isOpen && error && (
        <div className="bg-red-50 border border-red-200 text-red-700 px-3 py-2 rounded text-xs mb-4">
          {error}
          <button
            type="button"
            onClick={loadTags}
            className="block mt-2 underline"
          >
            Try Again
          </button>
        </div>
      )}

      {isOpen && (
        <div className="md:flex-1 md:overflow-y-auto overflow-x-auto">
          {tags.length === 0
            ? (
              <div className="text-center py-10 text-gray-500 text-sm">
                <p className="mb-2">No tags yet</p>
                <p className="text-xs">Create your first tag to get started</p>
              </div>
            )
            : (
              <ul className="md:space-y-1 md:flex-col flex flex-row gap-2 md:gap-0">
                {tags.map((tag) => (
                  <li
                    key={tag.uri}
                    className="group flex items-center justify-between px-3 py-2 rounded-lg hover:bg-gray-100 transition text-sm text-gray-700 md:w-auto whitespace-nowrap"
                    title={`Created ${
                      new Date(tag.createdAt).toLocaleDateString()
                    }`}
                    onClick={() => {
                      // Placeholder for future tag click action (e.g., filter bookmarks)
                      console.log("Tag clicked:", tag.value);
                    }}
                  >
                    <span className="flex-1 md:flex-initial">{tag.value}</span>
                    <div className="flex items-center gap-1">
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          setEditingTag(tag);
                        }}
                        className="opacity-0 group-hover:opacity-100 transition p-1 hover:bg-gray-200 rounded"
                        title="Edit tag"
                      >
                        <svg
                          className="w-4 h-4 text-gray-600"
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
                          // Find the parent li element and reduce its opacity
                          const listItem = (e.target as HTMLElement).closest(
                            "li",
                          );
                          if (listItem) {
                            listItem.style.opacity = "0.5";
                          }
                        }}
                        onDragEnd={(e) => {
                          e.stopPropagation();
                          // Find the parent li element and restore its opacity
                          const listItem = (e.target as HTMLElement).closest(
                            "li",
                          );
                          if (listItem) {
                            listItem.style.opacity = "1";
                          }
                        }}
                        className="opacity-0 group-hover:opacity-100 transition p-1 hover:bg-gray-200 rounded cursor-grab active:cursor-grabbing"
                        title="Drag to bookmark to tag it"
                      >
                        <svg
                          className="w-4 h-4 text-gray-600"
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
                ))}
              </ul>
            )}
        </div>
      )}

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
    </aside>
  );
}
