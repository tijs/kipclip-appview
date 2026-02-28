import { useState } from "react";
import type { EnrichedTag } from "../../shared/types.ts";
import { apiDelete } from "../utils/api.ts";

interface OrphanedTagsDialogProps {
  tags: EnrichedTag[];
  onComplete: (deletedTagUris: string[]) => void;
  onDismiss: () => void;
}

export function OrphanedTagsDialog({
  tags,
  onComplete,
  onDismiss,
}: OrphanedTagsDialogProps) {
  const [isDeleting, setIsDeleting] = useState(false);

  async function handleDelete() {
    setIsDeleting(true);
    const deletedUris: string[] = [];

    await Promise.all(tags.map(async (tag) => {
      const rkey = tag.uri.split("/").pop();
      if (!rkey) return;
      try {
        const res = await apiDelete(`/api/tags/${rkey}`);
        if (res.ok) deletedUris.push(tag.uri);
      } catch {
        // Continue with remaining tags
      }
    }));

    onComplete(deletedUris);
  }

  const single = tags.length === 1;

  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50"
      onClick={onDismiss}
    >
      <div
        className="bg-white rounded-lg shadow-xl max-w-md w-full p-6 fade-in"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-lg font-bold text-gray-800 mb-2">
          Orphaned {single ? "Tag" : "Tags"}
        </h3>
        <p className="text-sm text-gray-600 mb-4">
          {single
            ? "This tag is no longer used by any bookmark. Delete it?"
            : "These tags are no longer used by any bookmarks. Delete them?"}
        </p>

        <div className="flex flex-wrap gap-2 mb-6">
          {tags.map((tag) => (
            <span
              key={tag.uri}
              className="px-3 py-1 bg-gray-100 text-gray-700 rounded-full text-sm"
            >
              {tag.value}
            </span>
          ))}
        </div>

        <div className="flex gap-3">
          <button
            type="button"
            onClick={onDismiss}
            className="flex-1 px-4 py-2 rounded-lg border border-gray-300 text-gray-700 font-medium hover:bg-gray-50 transition"
            disabled={isDeleting}
          >
            Keep
          </button>
          <button
            type="button"
            onClick={handleDelete}
            className="flex-1 px-4 py-2 rounded-lg bg-red-50 text-red-600 font-medium hover:bg-red-100 transition border border-red-200"
            disabled={isDeleting}
          >
            {isDeleting ? "Deleting..." : `Delete ${single ? "Tag" : "Tags"}`}
          </button>
        </div>
      </div>
    </div>
  );
}
