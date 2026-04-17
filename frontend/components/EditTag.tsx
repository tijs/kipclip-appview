import { useState } from "react";
import type { EnrichedTag } from "../../shared/types.ts";
import { useApp } from "../context/AppContext.tsx";
import { apiDelete, apiGet, apiPut } from "../utils/api.ts";

interface EditTagProps {
  tag: EnrichedTag;
  onClose: () => void;
  onTagUpdated: (tag: EnrichedTag) => void;
  onTagDeleted: (tagUri: string) => void;
}

export function EditTag(
  { tag, onClose, onTagUpdated, onTagDeleted }: EditTagProps,
) {
  const { loadBookmarks } = useApp();
  const [value, setValue] = useState(tag.value);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Extract rkey from URI (format: at://did:plc:xxx/com.kipclip.tag/rkey)
  const rkey = tag.uri.split("/").pop()!;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();

    if (!value.trim()) {
      setError("Tag value cannot be empty");
      return;
    }

    const newValue = value.trim();
    const hasChanged = newValue !== tag.value;

    if (!hasChanged) {
      // No change, just close
      onClose();
      return;
    }

    setIsSubmitting(true);
    setError(null);

    try {
      const response = await apiPut(`/api/tags/${rkey}`, { value: newValue });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || "Failed to update tag");
      }

      const data = await response.json();

      // Refresh bookmarks since tag was renamed on them
      if (hasChanged) {
        await loadBookmarks();
      }

      if (data.tag) {
        onTagUpdated(data.tag);
      }
    } catch (err: any) {
      setError(err.message);
      setIsSubmitting(false);
    }
  }

  async function handleDelete() {
    setIsDeleting(true);
    setError(null);

    try {
      // First, fetch usage count
      const usageResponse = await apiGet(`/api/tags/${rkey}/usage`);
      if (!usageResponse.ok) {
        throw new Error("Failed to check tag usage");
      }

      const usageData = await usageResponse.json();
      const count = usageData.count || 0;

      // Show detailed confirmation
      let confirmMessage = `Delete tag "${tag.value}"?`;
      if (count > 0) {
        confirmMessage += `\n\nThis tag is used on ${count} bookmark${
          count === 1 ? "" : "s"
        } and will be removed from ${count === 1 ? "it" : "all of them"}.`;
        confirmMessage += "\n\nThis action cannot be undone.";
      }

      if (!confirm(confirmMessage)) {
        setIsDeleting(false);
        return;
      }

      // Delete the tag (backend will remove from bookmarks)
      const deleteResponse = await apiDelete(`/api/tags/${rkey}`);

      if (!deleteResponse.ok) {
        const data = await deleteResponse.json();
        throw new Error(data.error || "Failed to delete tag");
      }

      // Refresh bookmarks if any were affected
      if (count > 0) {
        await loadBookmarks();
      }

      onTagDeleted(tag.uri);
    } catch (err: any) {
      setError(err.message);
      setIsDeleting(false);
    }
  }

  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-lg shadow-xl max-w-md w-full p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-xl font-bold text-gray-800 mb-4">Edit Tag</h2>

        <form onSubmit={handleSubmit}>
          <div className="mb-4">
            <label
              htmlFor="tag-value"
              className="block text-sm font-medium text-gray-700 mb-2"
            >
              Tag Value
            </label>
            <input
              id="tag-value"
              type="text"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-coral"
              placeholder="Enter tag value"
              maxLength={64}
              disabled={isSubmitting || isDeleting}
              autoFocus
            />
            <p className="text-xs text-gray-500 mt-1">
              {value.length}/64 characters
            </p>
          </div>

          {error && (
            <div className="mb-4 bg-red-50 border border-red-200 text-red-700 px-3 py-2 rounded text-sm">
              {error}
            </div>
          )}

          <div className="flex gap-2 justify-between">
            <Button
              type="button"
              variant="danger"
              size="sm"
              onClick={handleDelete}
              loading={isDeleting}
              disabled={isSubmitting}
            >
              {isDeleting ? "Deleting..." : "Delete"}
            </Button>

            <div className="flex gap-2">
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={onClose}
                disabled={isSubmitting || isDeleting}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                variant="primary"
                size="sm"
                loading={isSubmitting}
                disabled={isDeleting || !value.trim()}
              >
                {isSubmitting ? "Saving..." : "Save"}
              </Button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}
