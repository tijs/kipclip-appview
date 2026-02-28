/**
 * Floating toolbar for bulk bookmark operations.
 * Appears at the bottom of the viewport when bookmarks are selected.
 */

import { useState } from "react";
import { BulkTagModal } from "./BulkTagModal.tsx";
import { apiPost } from "../utils/api.ts";
import type {
  BulkOperationRequest,
  BulkOperationResponse,
  EnrichedBookmark,
  EnrichedTag,
} from "../../shared/types.ts";

interface BulkActionToolbarProps {
  selectedCount: number;
  totalCount: number;
  selectedUris: Set<string>;
  bookmarks: EnrichedBookmark[];
  availableTags: EnrichedTag[];
  onSelectAll: () => void;
  onDeselectAll: () => void;
  onComplete: (
    deletedUris: string[],
    updatedBookmarks: EnrichedBookmark[],
  ) => void;
  onPartialFailure: (
    deletedUris: string[],
    updatedBookmarks: EnrichedBookmark[],
    failedUris: string[],
  ) => void;
}

export function BulkActionToolbar({
  selectedCount,
  totalCount,
  selectedUris,
  bookmarks,
  availableTags,
  onSelectAll,
  onDeselectAll,
  onComplete,
  onPartialFailure,
}: BulkActionToolbarProps) {
  const [isLoading, setIsLoading] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [tagModal, setTagModal] = useState<"add" | "remove" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const allSelected = selectedCount === totalCount;
  const uris = [...selectedUris];
  const selectedBookmarks = bookmarks.filter((b) => selectedUris.has(b.uri));

  async function handleDelete() {
    setIsLoading(true);
    setError(null);
    setConfirmDelete(false);
    try {
      const body: BulkOperationRequest = { action: "delete", uris };
      const res = await apiPost("/api/bookmarks/bulk", body);
      const data: BulkOperationResponse = await res.json();

      if (data.success) {
        onComplete(uris, []);
      } else if (data.succeeded > 0) {
        // Partial success: figure out which ones succeeded
        // Since we can't know exactly which failed, we reload
        // For now, treat all as potentially deleted and let the user retry
        const failedCount = data.failed;
        setError(`${data.succeeded} deleted, ${failedCount} failed`);
        onPartialFailure(
          uris.slice(0, data.succeeded),
          [],
          uris.slice(data.succeeded),
        );
      } else {
        setError(data.errors?.[0] || "Delete failed");
      }
    } catch (err: any) {
      setError(err.message || "Delete failed");
    } finally {
      setIsLoading(false);
    }
  }

  async function handleTagOperation(tags: string[], mode: "add" | "remove") {
    setIsLoading(true);
    setError(null);
    setTagModal(null);
    try {
      const action = mode === "add" ? "add-tags" : "remove-tags";
      const body: BulkOperationRequest = { action, uris, tags };
      const res = await apiPost("/api/bookmarks/bulk", body);
      const data: BulkOperationResponse = await res.json();

      if (data.success) {
        onComplete([], data.bookmarks || []);
      } else if (data.succeeded > 0) {
        setError(`${data.succeeded} updated, ${data.failed} failed`);
        const updatedUris = new Set(
          (data.bookmarks || []).map((b) => b.uri),
        );
        const failedUris = uris.filter((u) => !updatedUris.has(u));
        onPartialFailure([], data.bookmarks || [], failedUris);
      } else {
        setError(data.errors?.[0] || "Operation failed");
      }
    } catch (err: any) {
      setError(err.message || "Operation failed");
    } finally {
      setIsLoading(false);
    }
  }

  return (
    <>
      <div
        className="fixed bottom-4 left-1/2 -translate-x-1/2 z-30 bg-white rounded-xl shadow-lg border border-gray-200 px-4 py-3 flex items-center gap-3 animate-slide-up"
        role="toolbar"
        aria-label="Bulk actions"
      >
        {/* Selection count */}
        <span
          className="text-sm font-medium text-gray-700 whitespace-nowrap"
          aria-live="polite"
        >
          {selectedCount} selected
        </span>

        <div className="w-px h-6 bg-gray-200" />

        {/* Select all / Deselect all */}
        <button
          type="button"
          onClick={allSelected ? onDeselectAll : onSelectAll}
          className="text-sm text-blue-600 hover:text-blue-800 whitespace-nowrap"
          disabled={isLoading}
        >
          {allSelected ? "Deselect All" : "Select All"}
        </button>

        <div className="w-px h-6 bg-gray-200" />

        {/* Action buttons */}
        <button
          type="button"
          onClick={() => setTagModal("add")}
          className="text-sm text-gray-700 hover:text-gray-900 whitespace-nowrap"
          disabled={isLoading}
        >
          Add Tag
        </button>
        <button
          type="button"
          onClick={() => setTagModal("remove")}
          className="text-sm text-gray-700 hover:text-gray-900 whitespace-nowrap"
          disabled={isLoading}
        >
          Remove Tag
        </button>

        {confirmDelete
          ? (
            <div className="flex items-center gap-2">
              <span className="text-sm text-red-600 whitespace-nowrap">
                Delete {selectedCount}?
              </span>
              <button
                type="button"
                onClick={handleDelete}
                className="px-2 py-1 text-xs text-white bg-red-600 rounded hover:bg-red-700"
                disabled={isLoading}
              >
                {isLoading ? "..." : "Yes"}
              </button>
              <button
                type="button"
                onClick={() => setConfirmDelete(false)}
                className="px-2 py-1 text-xs text-gray-600 bg-gray-100 rounded hover:bg-gray-200"
                disabled={isLoading}
              >
                No
              </button>
            </div>
          )
          : (
            <button
              type="button"
              onClick={() => setConfirmDelete(true)}
              className="text-sm text-red-600 hover:text-red-800 whitespace-nowrap"
              disabled={isLoading}
            >
              Delete
            </button>
          )}

        {isLoading && (
          <div
            className="spinner w-4 h-4"
            style={{
              borderColor: "var(--coral) transparent transparent transparent",
            }}
          />
        )}

        {error && (
          <>
            <div className="w-px h-6 bg-gray-200" />
            <span className="text-sm text-red-600">{error}</span>
          </>
        )}
      </div>

      {/* Tag modals */}
      {tagModal && (
        <BulkTagModal
          mode={tagModal}
          selectedBookmarks={selectedBookmarks}
          availableTags={availableTags}
          onSubmit={(tags) => handleTagOperation(tags, tagModal)}
          onClose={() => setTagModal(null)}
        />
      )}
    </>
  );
}
