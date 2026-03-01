import { useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useApp } from "../context/AppContext.tsx";
import { type DateFormatOption, formatDate } from "../../shared/date-format.ts";
import type { EnrichedBookmark } from "../../shared/types.ts";

function ReadingListCard(
  { bookmark, dateFormat }: {
    bookmark: EnrichedBookmark;
    dateFormat?: DateFormatOption;
  },
) {
  // Extract domain from URL
  const domain = (() => {
    try {
      return new URL(bookmark.subject).hostname.replace("www.", "");
    } catch {
      return bookmark.subject;
    }
  })();

  const formattedDate = formatDate(bookmark.createdAt, dateFormat);

  const handleClick = () => {
    globalThis.open(bookmark.subject, "_blank", "noopener,noreferrer");
  };

  return (
    <article
      onClick={handleClick}
      className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden cursor-pointer transition-shadow hover:shadow-md"
    >
      {bookmark.image && (
        <div className="aspect-[2/1] bg-gray-100 overflow-hidden">
          <img
            src={bookmark.image}
            alt=""
            className="w-full h-full object-cover"
            onError={(e) => {
              (e.target as HTMLImageElement).parentElement!.style.display =
                "none";
            }}
          />
        </div>
      )}
      <div className="p-6">
        <h3 className="text-lg font-semibold text-gray-900 mb-2 line-clamp-2">
          {bookmark.title || domain}
        </h3>
        {bookmark.description && (
          <p className="text-gray-600 text-sm mb-4 line-clamp-3">
            {bookmark.description}
          </p>
        )}
        <div className="flex items-center gap-2 text-sm text-gray-500">
          {bookmark.favicon && (
            <img
              src={bookmark.favicon}
              alt=""
              className="w-4 h-4"
              onError={(e) => {
                (e.target as HTMLImageElement).style.display = "none";
              }}
            />
          )}
          <span>{domain}</span>
          <span className="text-gray-300">|</span>
          <span>{formattedDate}</span>
        </div>
      </div>
    </article>
  );
}

function ReadingListEmpty({ tagName }: { tagName: string }) {
  return (
    <div className="flex-1 flex items-center justify-center p-8">
      <div className="text-center max-w-md">
        <div className="text-6xl mb-4">📚</div>
        <h3 className="text-xl font-semibold text-gray-800 mb-2">
          No articles in your reading list
        </h3>
        <p className="text-gray-600 mb-4">
          Bookmarks tagged with "{tagName}" will appear here. Add this tag to
          any bookmark to save it for later reading.
        </p>
        <a
          href="/settings"
          className="inline-block px-4 py-2 text-sm font-medium rounded-lg transition-colors"
          style={{
            backgroundColor: "rgba(230, 100, 86, 0.1)",
            color: "var(--coral)",
          }}
        >
          Change tag in Settings
        </a>
      </div>
    </div>
  );
}

function ReadingListTagSidebar() {
  const {
    readingListTags,
    readingListSelectedTags,
    toggleReadingListTag,
    clearReadingListFilters,
    preferences,
  } = useApp();

  if (readingListTags.length === 0) {
    return null;
  }

  return (
    <>
      {/* Desktop sidebar */}
      <aside className="hidden md:flex flex-col w-64 bg-white border-r border-gray-200 flex-shrink-0">
        <div className="p-4 border-b border-gray-200">
          <h2 className="text-sm font-semibold text-gray-700">Filter by Tag</h2>
        </div>
        <div className="flex-1 overflow-y-auto p-4">
          <div className="space-y-1">
            {readingListTags.map((tag) => {
              const isSelected = readingListSelectedTags.has(tag);
              const isReadingListTag = tag === preferences.readingListTag;
              return (
                <button
                  type="button"
                  key={tag}
                  onClick={() => toggleReadingListTag(tag)}
                  className={`w-full text-left px-3 py-2 rounded-lg text-sm transition-colors flex items-center gap-2 ${
                    isSelected
                      ? "bg-blue-50 text-blue-700"
                      : "text-gray-700 hover:bg-gray-100"
                  }`}
                >
                  {isSelected && (
                    <svg
                      className="w-4 h-4 flex-shrink-0"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M5 13l4 4L19 7"
                      />
                    </svg>
                  )}
                  <span className="truncate">{tag}</span>
                  {isReadingListTag && (
                    <span className="ml-auto text-xs text-gray-400">
                      primary
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </div>
        {readingListSelectedTags.size > 0 && (
          <div className="p-4 border-t border-gray-200">
            <button
              type="button"
              onClick={clearReadingListFilters}
              className="w-full px-3 py-2 text-sm text-gray-600 hover:text-gray-800 hover:bg-gray-100 rounded-lg transition-colors"
            >
              Clear filters
            </button>
          </div>
        )}
      </aside>

      {/* Mobile horizontal bar */}
      <div className="md:hidden bg-white border-b border-gray-200 px-4 py-3 overflow-x-auto">
        <div className="flex items-center gap-2">
          {readingListTags.map((tag) => {
            const isSelected = readingListSelectedTags.has(tag);
            return (
              <button
                type="button"
                key={tag}
                onClick={() => toggleReadingListTag(tag)}
                className={`flex-shrink-0 px-3 py-1.5 rounded-full text-sm transition-colors ${
                  isSelected
                    ? "bg-blue-100 text-blue-700"
                    : "bg-gray-100 text-gray-700"
                }`}
              >
                {tag}
              </button>
            );
          })}
          {readingListSelectedTags.size > 0 && (
            <button
              type="button"
              onClick={clearReadingListFilters}
              className="flex-shrink-0 px-3 py-1.5 text-sm text-gray-500 hover:text-gray-700"
            >
              Clear
            </button>
          )}
        </div>
      </div>
    </>
  );
}

function VirtualReadingList(
  { items, dateFormat }: {
    items: EnrichedBookmark[];
    dateFormat: DateFormatOption;
  },
) {
  const parentRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 200,
    overscan: 5,
  });

  return (
    <div ref={parentRef} style={{ height: "100%", overflow: "auto" }}>
      <div
        style={{
          height: `${virtualizer.getTotalSize()}px`,
          width: "100%",
          position: "relative",
        }}
      >
        {virtualizer.getVirtualItems().map((virtualRow) => (
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
            <div className="pb-4">
              <ReadingListCard
                bookmark={items[virtualRow.index]}
                dateFormat={dateFormat}
              />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function ReadingList() {
  const {
    filteredReadingList,
    readingListBookmarks,
    totalReadingList,
    preferences,
    readingListSearchQuery,
    setReadingListSearchQuery,
  } = useApp();
  const dateFormat = preferences.dateFormat as DateFormatOption;
  const [mobileSearchOpen, setMobileSearchOpen] = useState(false);

  // If there are no reading list bookmarks at all, show empty state
  if (readingListBookmarks.length === 0) {
    return (
      <div className="flex flex-col md:flex-row flex-1 md:overflow-hidden">
        <ReadingListEmpty tagName={preferences.readingListTag} />
      </div>
    );
  }

  return (
    <div className="flex flex-col md:flex-row flex-1 md:overflow-hidden">
      <ReadingListTagSidebar />
      <main className="flex-1 px-4 py-8 md:overflow-y-auto">
        <div className="max-w-3xl mx-auto">
          {/* Desktop header with search */}
          <div className="hidden md:block mb-6">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-2xl font-bold text-gray-800">
                Reading List
              </h2>
              <span className="text-sm text-gray-500">
                {readingListSearchQuery.trim()
                  ? `${filteredReadingList.length} of ${totalReadingList}`
                  : filteredReadingList.length}{" "}
                article{filteredReadingList.length !== 1 ? "s" : ""}
              </span>
            </div>
            <input
              type="text"
              placeholder="Search reading list..."
              value={readingListSearchQuery}
              onChange={(e) => setReadingListSearchQuery(e.target.value)}
              className="w-full px-4 py-2 rounded-lg border border-gray-300 focus:ring-2 focus:ring-coral focus:border-transparent outline-none transition"
            />
          </div>

          {/* Mobile header with expandable search */}
          <div className="md:hidden mb-6">
            {mobileSearchOpen
              ? (
                <div className="flex items-center gap-2 mb-2">
                  <input
                    type="text"
                    placeholder="Search reading list..."
                    value={readingListSearchQuery}
                    onChange={(e) => setReadingListSearchQuery(e.target.value)}
                    className="flex-1 px-3 py-2 rounded-lg border border-gray-300 focus:ring-2 focus:ring-coral focus:border-transparent outline-none"
                    autoFocus
                  />
                  <button
                    type="button"
                    onClick={() => {
                      setMobileSearchOpen(false);
                      setReadingListSearchQuery("");
                    }}
                    className="p-2 text-gray-500 hover:text-gray-700"
                  >
                    <svg
                      className="w-5 h-5"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M6 18L18 6M6 6l12 12"
                      />
                    </svg>
                  </button>
                </div>
              )
              : (
                <div className="flex items-center justify-between mb-2">
                  <h2 className="text-2xl font-bold text-gray-800">
                    Reading List
                  </h2>
                  <button
                    type="button"
                    onClick={() => setMobileSearchOpen(true)}
                    className="p-2 text-gray-500 hover:text-gray-700"
                  >
                    <svg
                      className="w-5 h-5"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
                      />
                    </svg>
                  </button>
                </div>
              )}
            <p className="text-sm text-gray-500">
              {readingListSearchQuery.trim()
                ? `${filteredReadingList.length} of ${totalReadingList}`
                : filteredReadingList.length}{" "}
              article{filteredReadingList.length !== 1 ? "s" : ""}
            </p>
          </div>
          {filteredReadingList.length === 0
            ? (
              <div className="text-center py-12 text-gray-500">
                No articles match the selected filters.
              </div>
            )
            : (
              <VirtualReadingList
                items={filteredReadingList}
                dateFormat={dateFormat}
              />
            )}
        </div>
      </main>
    </div>
  );
}
