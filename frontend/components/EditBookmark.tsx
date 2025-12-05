import { useState } from "react";
import type { EnrichedBookmark, EnrichedTag } from "../../shared/types.ts";

interface EditBookmarkProps {
  bookmark: EnrichedBookmark;
  availableTags: EnrichedTag[];
  onClose: () => void;
  onBookmarkUpdated: (bookmark: EnrichedBookmark) => void;
  onBookmarkDeleted: (uri: string) => void;
  onTagsChanged?: () => void;
}

export function EditBookmark({
  bookmark,
  availableTags,
  onClose,
  onBookmarkUpdated,
  onBookmarkDeleted,
  onTagsChanged,
}: EditBookmarkProps) {
  const [tags, setTags] = useState<string[]>(bookmark.tags || []);
  const [tagInput, setTagInput] = useState("");
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Editable fields state
  const [title, setTitle] = useState(bookmark.title || "");
  const [url, setUrl] = useState(bookmark.subject);
  const [description, setDescription] = useState(bookmark.description || "");

  // Filter suggestions based on input
  const suggestions = availableTags
    .filter((tag) =>
      tag.value.toLowerCase().includes(tagInput.toLowerCase()) &&
      !tags.includes(tag.value)
    )
    .slice(0, 5);

  function handleAddTag(tagValue: string) {
    if (tagValue && !tags.includes(tagValue)) {
      setTags([...tags, tagValue]);
      setTagInput("");
      setShowSuggestions(false);
    }
  }

  function handleRemoveTag(tagValue: string) {
    setTags(tags.filter((t) => t !== tagValue));
  }

  function handleTagInputKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") {
      e.preventDefault();
      if (suggestions.length > 0) {
        handleAddTag(suggestions[0].value);
      } else if (tagInput.trim()) {
        handleAddTag(tagInput.trim());
      }
    } else if (e.key === "Escape") {
      setShowSuggestions(false);
    }
  }

  async function handleSave() {
    setLoading(true);
    setError(null);

    try {
      // Find new tags that don't exist in availableTags
      const existingTagValues = new Set(availableTags.map((t) => t.value));
      const newTags = tags.filter((tag) => !existingTagValues.has(tag));

      // Create tag records for new tags
      for (const tagValue of newTags) {
        try {
          await fetch("/api/tags", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ value: tagValue }),
          });
        } catch (err) {
          console.error(`Failed to create tag record for "${tagValue}":`, err);
          // Continue even if tag creation fails
        }
      }

      // Update bookmark with all editable fields
      const rkey = bookmark.uri.split("/").pop();
      const response = await fetch(`/api/bookmarks/${rkey}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          tags,
          title,
          url,
          description,
        }),
      });

      if (!response.ok) {
        throw new Error("Failed to update bookmark");
      }

      const data = await response.json();

      // Refresh tag list if new tags were created
      if (newTags.length > 0 && onTagsChanged) {
        onTagsChanged();
      }

      onBookmarkUpdated(data.bookmark);
    } catch (err: any) {
      setError(err.message);
      setLoading(false);
    }
  }

  async function handleDelete() {
    if (!confirm("Are you sure you want to delete this bookmark?")) {
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const rkey = bookmark.uri.split("/").pop();
      const response = await fetch(`/api/bookmarks/${rkey}`, {
        method: "DELETE",
      });

      if (!response.ok) {
        throw new Error("Failed to delete bookmark");
      }

      onBookmarkDeleted(bookmark.uri);
    } catch (err: any) {
      setError(err.message);
      setLoading(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
      <div className="bg-white rounded-lg max-w-2xl w-full max-h-[90vh] overflow-y-auto fade-in">
        <div className="sticky top-0 bg-white border-b border-gray-200 px-6 py-4">
          <div className="flex items-center justify-between">
            <h3 className="text-xl font-bold text-gray-800">Edit Bookmark</h3>
            <button
              type="button"
              onClick={onClose}
              className="text-gray-400 hover:text-gray-600 text-2xl"
              disabled={loading}
            >
              ×
            </button>
          </div>
        </div>

        <div className="px-6 py-4 space-y-4">
          {/* Title - Editable */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Title
            </label>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Enter bookmark title"
              className="w-full px-4 py-3 rounded-lg border border-gray-300 focus:ring-2 focus:ring-coral focus:border-transparent outline-none transition"
              disabled={loading}
            />
          </div>

          {/* URL - Editable */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              URL
            </label>
            <input
              type="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://example.com"
              className="w-full px-4 py-3 rounded-lg border border-gray-300 focus:ring-2 focus:ring-coral focus:border-transparent outline-none transition"
              disabled={loading}
            />
          </div>

          {/* Description - Editable */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Description
            </label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Enter bookmark description (optional)"
              rows={3}
              className="w-full px-4 py-3 rounded-lg border border-gray-300 focus:ring-2 focus:ring-coral focus:border-transparent outline-none transition resize-y"
              disabled={loading}
            />
          </div>

          {/* Tags - Editable */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Tags
            </label>

            {/* Current tags */}
            {tags.length > 0 && (
              <div className="flex flex-wrap gap-2 mb-3">
                {tags.map((tag) => (
                  <span
                    key={tag}
                    className="inline-flex items-center gap-1 px-3 py-1 rounded-full bg-gray-100 text-gray-700 text-sm"
                  >
                    {tag}
                    <button
                      type="button"
                      onClick={() => handleRemoveTag(tag)}
                      className="text-gray-500 hover:text-red-600 ml-1"
                      disabled={loading}
                    >
                      ×
                    </button>
                  </span>
                ))}
              </div>
            )}

            {/* Add tag input */}
            <div className="relative">
              <input
                type="text"
                value={tagInput}
                onChange={(e) => {
                  setTagInput(e.target.value);
                  setShowSuggestions(true);
                }}
                onKeyDown={handleTagInputKeyDown}
                onFocus={() => setShowSuggestions(true)}
                onBlur={() => setTimeout(() => setShowSuggestions(false), 200)}
                placeholder="Add tags..."
                className="w-full px-4 py-3 rounded-lg border border-gray-300 focus:ring-2 focus:ring-coral focus:border-transparent outline-none transition"
                disabled={loading}
              />

              {/* Suggestions dropdown */}
              {showSuggestions && suggestions.length > 0 && (
                <div className="absolute z-10 w-full mt-1 bg-white border border-gray-200 rounded-lg shadow-lg max-h-48 overflow-y-auto">
                  {suggestions.map((tag) => (
                    <button
                      key={tag.uri}
                      type="button"
                      onClick={() => handleAddTag(tag.value)}
                      className="w-full text-left px-4 py-2 hover:bg-gray-50 text-gray-700 text-sm"
                    >
                      {tag.value}
                    </button>
                  ))}
                </div>
              )}
            </div>

            <p className="text-xs text-gray-500 mt-2">
              Type to search existing tags or press Enter to create a new one
            </p>
          </div>

          {/* Created date */}
          <div className="text-xs text-gray-400 pt-2">
            Created {new Date(bookmark.createdAt).toLocaleDateString()} at{" "}
            {new Date(bookmark.createdAt).toLocaleTimeString()}
          </div>

          {error && (
            <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg text-sm">
              {error}
            </div>
          )}
        </div>

        {/* Footer with action buttons */}
        <div className="sticky bottom-0 bg-white border-t border-gray-200 px-6 py-4 space-y-3">
          <div className="flex gap-3">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 px-4 py-3 rounded-lg border border-gray-300 text-gray-700 font-medium hover:bg-gray-50 transition"
              disabled={loading}
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleSave}
              className="flex-1 btn-primary disabled:opacity-50"
              disabled={loading}
            >
              {loading
                ? (
                  <span className="flex items-center justify-center gap-2">
                    <div className="spinner w-5 h-5 border-2"></div>
                    Saving...
                  </span>
                )
                : (
                  "Save Changes"
                )}
            </button>
          </div>

          <button
            type="button"
            onClick={handleDelete}
            className="w-full px-4 py-3 rounded-lg bg-red-50 text-red-600 font-medium hover:bg-red-100 transition border border-red-200"
            disabled={loading}
          >
            Delete Bookmark
          </button>
        </div>
      </div>
    </div>
  );
}
