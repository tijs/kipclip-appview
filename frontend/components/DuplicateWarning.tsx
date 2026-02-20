import type { EnrichedBookmark } from "../../shared/types.ts";

interface DuplicateWarningProps {
  duplicates: EnrichedBookmark[];
  onCancel: () => void;
  onContinue: () => void;
  loading: boolean;
}

export function DuplicateWarning({
  duplicates,
  onCancel,
  onContinue,
  loading,
}: DuplicateWarningProps) {
  return (
    <div className="space-y-4">
      <div className="bg-amber-50 border border-amber-200 rounded-lg p-4">
        <div className="flex items-start gap-3">
          <svg
            className="w-5 h-5 text-amber-600 mt-0.5 flex-shrink-0"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z"
            />
          </svg>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-amber-800">
              You already have{" "}
              {duplicates.length === 1 ? "a bookmark" : "bookmarks"}{" "}
              for this URL
            </p>
            <ul className="mt-2 space-y-2">
              {duplicates.map((bookmark) => {
                let hostname = "";
                try {
                  hostname = new URL(bookmark.subject).hostname;
                } catch {
                  hostname = bookmark.subject;
                }
                return (
                  <li
                    key={bookmark.uri}
                    className="text-sm text-amber-700 border-t border-amber-100 pt-2"
                  >
                    <p className="font-medium truncate">
                      {bookmark.title || hostname}
                    </p>
                    <p className="text-xs text-amber-600 truncate">
                      {bookmark.subject}
                    </p>
                    <div className="flex items-center gap-2 mt-1 text-xs text-amber-500">
                      <span>
                        {new Date(bookmark.createdAt).toLocaleDateString()}
                      </span>
                      {bookmark.tags && bookmark.tags.length > 0 && (
                        <span>
                          {bookmark.tags.join(", ")}
                        </span>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>
        </div>
      </div>

      <div className="flex gap-3">
        <button
          type="button"
          onClick={onCancel}
          className="flex-1 px-4 py-3 rounded-lg border border-gray-300 text-gray-700 font-medium hover:bg-gray-50 transition"
          disabled={loading}
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={onContinue}
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
            : "Save Anyway"}
        </button>
      </div>
    </div>
  );
}
