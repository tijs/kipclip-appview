/**
 * Modal for bulk tag operations (add or remove tags from selected bookmarks).
 */

import { useState } from "react";
import { TagInput } from "./TagInput.tsx";
import type { EnrichedBookmark, EnrichedTag } from "../../shared/types.ts";

interface BulkTagModalProps {
  mode: "add" | "remove";
  selectedBookmarks: EnrichedBookmark[];
  availableTags: EnrichedTag[];
  onSubmit: (tags: string[]) => void;
  onClose: () => void;
}

export function BulkTagModal({
  mode,
  selectedBookmarks,
  availableTags,
  onSubmit,
  onClose,
}: BulkTagModalProps) {
  const [selectedTags, setSelectedTags] = useState<string[]>([]);

  // For remove mode, only show tags that exist on ALL selected bookmarks
  const intersectionTags = mode === "remove"
    ? getIntersectionTags(selectedBookmarks)
    : [];

  function handleSubmit() {
    if (selectedTags.length === 0) return;
    onSubmit(selectedTags);
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-xl shadow-xl w-full max-w-md mx-4 p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-lg font-semibold text-gray-800 mb-1">
          {mode === "add" ? "Add Tags" : "Remove Tags"}
        </h3>
        <p className="text-sm text-gray-500 mb-4">
          {mode === "add"
            ? `Add tags to ${selectedBookmarks.length} selected bookmark${selectedBookmarks.length === 1 ? "" : "s"}`
            : `Remove tags from ${selectedBookmarks.length} selected bookmark${selectedBookmarks.length === 1 ? "" : "s"}`}
        </p>

        {mode === "add"
          ? (
            <TagInput
              tags={selectedTags}
              onTagsChange={setSelectedTags}
              availableTags={availableTags}
              compact
            />
          )
          : (
            <div>
              {intersectionTags.length === 0
                ? (
                  <p className="text-sm text-gray-500 italic">
                    No tags are shared across all selected bookmarks.
                  </p>
                )
                : (
                  <div className="flex flex-wrap gap-2">
                    {intersectionTags.map((tag) => (
                      <button
                        key={tag}
                        type="button"
                        onClick={() => {
                          setSelectedTags((prev) =>
                            prev.includes(tag)
                              ? prev.filter((t) => t !== tag)
                              : [...prev, tag]
                          );
                        }}
                        className={`px-3 py-1.5 rounded-full text-sm border transition ${
                          selectedTags.includes(tag)
                            ? "bg-red-50 border-red-300 text-red-700"
                            : "bg-gray-50 border-gray-200 text-gray-700 hover:bg-gray-100"
                        }`}
                      >
                        {tag}
                        {selectedTags.includes(tag) && " ×"}
                      </button>
                    ))}
                  </div>
                )}
            </div>
          )}

        <div className="flex justify-end gap-3 mt-6">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 text-sm text-gray-700 hover:bg-gray-100 rounded-lg"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={selectedTags.length === 0}
            className={`px-4 py-2 text-sm text-white rounded-lg ${
              selectedTags.length === 0
                ? "bg-gray-300 cursor-not-allowed"
                : mode === "add"
                ? "bg-blue-600 hover:bg-blue-700"
                : "bg-red-600 hover:bg-red-700"
            }`}
          >
            {mode === "add" ? "Add Tags" : "Remove Tags"}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Get tags that appear on ALL selected bookmarks. */
function getIntersectionTags(bookmarks: EnrichedBookmark[]): string[] {
  if (bookmarks.length === 0) return [];
  const first = new Set(bookmarks[0].tags || []);
  for (let i = 1; i < bookmarks.length; i++) {
    const tags = new Set(bookmarks[i].tags || []);
    for (const tag of first) {
      if (!tags.has(tag)) first.delete(tag);
    }
  }
  return [...first].sort();
}
