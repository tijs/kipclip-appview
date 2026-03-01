import { useCallback, useEffect, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { BookmarkCard, type ViewMode } from "./BookmarkCard.tsx";
import { SwipeableRow } from "./SwipeableRow.tsx";
import type { DateFormatOption } from "../../shared/date-format.ts";
import type { EnrichedBookmark } from "../../shared/types.ts";

interface VirtualBookmarkListProps {
  bookmarks: EnrichedBookmark[];
  viewMode: ViewMode;
  dateFormat: DateFormatOption;
  isSelectMode: boolean;
  selectedUris: Set<string>;
  dragOverBookmark: string | null;
  imageErrors: Set<string>;
  onBookmarkClick: (bookmark: EnrichedBookmark) => void;
  onDragOverBookmark: (uri: string | null) => void;
  onDropTag: (bookmarkUri: string, tagValue: string) => void;
  onImageError: (bookmarkUri: string) => void;
  onSwipeDelete: (bookmark: EnrichedBookmark) => Promise<void>;
}

function useColumnCount(viewMode: ViewMode): number {
  const [columns, setColumns] = useState(() =>
    viewMode === "cards" ? getCardColumns() : 1
  );

  useEffect(() => {
    if (viewMode !== "cards") {
      setColumns(1);
      return;
    }
    function update() {
      setColumns(getCardColumns());
    }
    update();
    globalThis.addEventListener("resize", update);
    return () => globalThis.removeEventListener("resize", update);
  }, [viewMode]);

  return columns;
}

function getCardColumns(): number {
  const w = globalThis.innerWidth;
  if (w >= 1024) return 3; // lg
  if (w >= 768) return 2; // md
  return 1;
}

export function VirtualBookmarkList({
  bookmarks,
  viewMode,
  dateFormat,
  isSelectMode,
  selectedUris,
  dragOverBookmark,
  imageErrors,
  onBookmarkClick,
  onDragOverBookmark,
  onDropTag,
  onImageError,
  onSwipeDelete,
}: VirtualBookmarkListProps) {
  const parentRef = useRef<HTMLDivElement>(null);
  const columns = useColumnCount(viewMode);

  // For card view, chunk bookmarks into rows
  const rows = viewMode === "cards"
    ? chunkArray(bookmarks, columns)
    : bookmarks.map((b) => [b]);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => viewMode === "cards" ? 280 : 64,
    overscan: 5,
  });

  const renderCard = useCallback(
    (bookmark: EnrichedBookmark) => (
      <BookmarkCard
        key={bookmark.uri}
        bookmark={bookmark}
        viewMode={viewMode}
        isDragOver={dragOverBookmark === bookmark.uri}
        imageError={imageErrors.has(bookmark.uri)}
        dateFormat={dateFormat}
        isSelectMode={isSelectMode}
        isSelected={selectedUris.has(bookmark.uri)}
        onClick={() => onBookmarkClick(bookmark)}
        onDragOver={(e) => {
          e.preventDefault();
          e.dataTransfer.dropEffect = "copy";
        }}
        onDragEnter={(e) => {
          e.preventDefault();
          onDragOverBookmark(bookmark.uri);
        }}
        onDragLeave={(e) => {
          e.preventDefault();
          if (e.currentTarget === e.target) {
            onDragOverBookmark(null);
          }
        }}
        onDrop={(e) => {
          e.preventDefault();
          onDragOverBookmark(null);
          const tagValue = e.dataTransfer.getData("text/plain");
          if (tagValue) {
            onDropTag(bookmark.uri, tagValue);
          }
        }}
        onImageError={() => onImageError(bookmark.uri)}
      />
    ),
    [
      viewMode,
      dragOverBookmark,
      imageErrors,
      dateFormat,
      isSelectMode,
      selectedUris,
      onBookmarkClick,
      onDragOverBookmark,
      onDropTag,
      onImageError,
    ],
  );

  return (
    <div
      ref={parentRef}
      style={{
        height: "100%",
        overflow: "auto",
      }}
    >
      <div
        style={{
          height: `${virtualizer.getTotalSize()}px`,
          width: "100%",
          position: "relative",
        }}
      >
        {virtualizer.getVirtualItems().map((virtualRow) => {
          const row = rows[virtualRow.index];
          return (
            <div
              key={virtualRow.key}
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                width: "100%",
                transform: `translateY(${virtualRow.start}px)`,
              }}
              data-index={virtualRow.index}
              ref={virtualizer.measureElement}
            >
              {viewMode === "cards"
                ? (
                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                    {row.map((bookmark) => renderCard(bookmark))}
                  </div>
                )
                : (
                  <div className="flex flex-col gap-2">
                    {row.map((bookmark) => {
                      const card = renderCard(bookmark);
                      if (!isSelectMode) {
                        return (
                          <SwipeableRow
                            key={bookmark.uri}
                            onDelete={() => onSwipeDelete(bookmark)}
                          >
                            {card}
                          </SwipeableRow>
                        );
                      }
                      return card;
                    })}
                  </div>
                )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function chunkArray<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}
