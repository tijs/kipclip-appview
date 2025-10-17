/** @jsxImportSource https://esm.sh/react */
import { useEffect, useState } from "https://esm.sh/react";
import { AddTag } from "./AddTag.tsx";
import { EditTag } from "./EditTag.tsx";
import type { EnrichedTag } from "../../shared/types.ts";

export function TagSidebar() {
  const [tags, setTags] = useState<EnrichedTag[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAddModal, setShowAddModal] = useState(false);
  const [editingTag, setEditingTag] = useState<EnrichedTag | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadTags();
  }, []);

  async function loadTags() {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/tags");
      if (!response.ok) {
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
      <aside className="w-64 bg-white border-r border-gray-200 p-4">
        <div className="flex items-center justify-center py-10">
          <div className="spinner"></div>
        </div>
      </aside>
    );
  }

  return (
    <aside className="w-64 bg-white border-r border-gray-200 p-4 flex flex-col">
      <div className="mb-4">
        <h2 className="text-lg font-bold text-gray-800 mb-3">Tags</h2>
        <button
          type="button"
          onClick={() => setShowAddModal(true)}
          className="w-full btn-primary text-sm py-2"
        >
          + Create Tag
        </button>
      </div>

      {error && (
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

      <div className="flex-1 overflow-y-auto">
        {tags.length === 0
          ? (
            <div className="text-center py-10 text-gray-500 text-sm">
              <p className="mb-2">No tags yet</p>
              <p className="text-xs">Create your first tag to get started</p>
            </div>
          )
          : (
            <ul className="space-y-1">
              {tags.map((tag) => (
                <li
                  key={tag.uri}
                  className="group flex items-center justify-between px-3 py-2 rounded-lg hover:bg-gray-100 transition cursor-pointer text-sm text-gray-700"
                  title={`Created ${
                    new Date(tag.createdAt).toLocaleDateString()
                  }`}
                  onClick={() => {
                    // Placeholder for future tag click action (e.g., filter bookmarks)
                    console.log("Tag clicked:", tag.value);
                  }}
                >
                  <span className="flex-1">{tag.value}</span>
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
                </li>
              ))}
            </ul>
          )}
      </div>

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
