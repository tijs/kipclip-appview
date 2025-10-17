/** @jsxImportSource https://esm.sh/react */
import { useState } from "https://esm.sh/react";
import type { EnrichedTag } from "../../shared/types.ts";

interface EditTagProps {
  tag: EnrichedTag;
  onClose: () => void;
  onTagUpdated: (tag: EnrichedTag) => void;
  onTagDeleted: (tagUri: string) => void;
}

export function EditTag(
  { tag, onClose, onTagUpdated, onTagDeleted }: EditTagProps,
) {
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

    if (value.trim() === tag.value) {
      // No change, just close
      onClose();
      return;
    }

    setIsSubmitting(true);
    setError(null);

    try {
      const response = await fetch(`/api/tags/${rkey}`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ value: value.trim() }),
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || "Failed to update tag");
      }

      const data = await response.json();
      if (data.tag) {
        onTagUpdated(data.tag);
      }
    } catch (err: any) {
      setError(err.message);
      setIsSubmitting(false);
    }
  }

  async function handleDelete() {
    if (!confirm(`Delete tag "${tag.value}"?`)) {
      return;
    }

    setIsDeleting(true);
    setError(null);

    try {
      const response = await fetch(`/api/tags/${rkey}`, {
        method: "DELETE",
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || "Failed to delete tag");
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
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
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
            <button
              type="button"
              onClick={handleDelete}
              disabled={isSubmitting || isDeleting}
              className="px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed transition text-sm font-medium"
            >
              {isDeleting ? "Deleting..." : "Delete"}
            </button>

            <div className="flex gap-2">
              <button
                type="button"
                onClick={onClose}
                disabled={isSubmitting || isDeleting}
                className="px-4 py-2 bg-gray-200 text-gray-800 rounded-lg hover:bg-gray-300 disabled:opacity-50 disabled:cursor-not-allowed transition text-sm font-medium"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={isSubmitting || isDeleting || !value.trim()}
                className="px-4 py-2 btn-primary disabled:opacity-50 disabled:cursor-not-allowed text-sm font-medium"
              >
                {isSubmitting ? "Saving..." : "Save"}
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}
