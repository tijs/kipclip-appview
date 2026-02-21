import { useState } from "react";
import type { EnrichedBookmark, EnrichedTag } from "../../shared/types.ts";
import { TagInput } from "./TagInput.tsx";

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
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Editable fields state
  const [title, setTitle] = useState(bookmark.title || "");
  const [url, setUrl] = useState(bookmark.subject);
  const [description, setDescription] = useState(bookmark.description || "");
  const [note, setNote] = useState(bookmark.note || "");
  const [showNoteInput, setShowNoteInput] = useState(!!bookmark.note);

  async function handleSave() {
    setLoading(true);
    setError(null);

    try {
      // Find new tags that don't exist in availableTags
      const existingTagValues = new Set(availableTags.map((t) => t.value));
      const newTags = tags.filter((tag) => !existingTagValues.has(tag));

      // Create tag records for new tags (parallel, non-blocking)
      const tagPromises = newTags.map((tagValue) =>
        fetch("/api/tags", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ value: tagValue }),
        }).catch((err) =>
          console.error(`Failed to create tag record for "${tagValue}":`, err)
        )
      );

      // Start tag creation and bookmark update in parallel
      const rkey = bookmark.uri.split("/").pop();
      const [response] = await Promise.all([
        fetch(`/api/bookmarks/${rkey}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            tags,
            title,
            url,
            description,
            note: note.trim() || undefined,
          }),
        }),
        ...tagPromises,
      ]);

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

          {/* Note - Editable */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Note
            </label>
            {showNoteInput
              ? (
                <textarea
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="Add a personal note about this bookmark..."
                  rows={4}
                  className="w-full px-4 py-3 rounded-lg border border-gray-300 focus:ring-2 focus:ring-coral focus:border-transparent outline-none transition resize-y"
                  disabled={loading}
                  autoFocus={!bookmark.note}
                />
              )
              : (
                <button
                  type="button"
                  onClick={() => setShowNoteInput(true)}
                  className="text-sm text-gray-500 hover:text-gray-700 px-4 py-2.5 rounded-lg border border-dashed border-gray-300 hover:border-gray-400 transition w-full text-left"
                  disabled={loading}
                >
                  + Add a note
                </button>
              )}
          </div>

          {/* Tags - Editable */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Tags
            </label>
            <TagInput
              tags={tags}
              onTagsChange={setTags}
              availableTags={availableTags}
              disabled={loading}
            />
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
