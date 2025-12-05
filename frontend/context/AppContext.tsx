import { createContext, type ReactNode, useContext, useState } from "react";
import type {
  EnrichedBookmark,
  EnrichedTag,
  InitialDataResponse,
  SessionInfo,
} from "../../shared/types.ts";
import { apiGet } from "../utils/api.ts";

interface AppState {
  session: SessionInfo | null;
  bookmarks: EnrichedBookmark[];
  tags: EnrichedTag[];
  selectedTags: Set<string>;
  loading: boolean;
}

interface AppContextValue extends AppState {
  // Session actions
  setSession: (session: SessionInfo | null) => void;

  // Bookmark actions
  setBookmarks: (bookmarks: EnrichedBookmark[]) => void;
  addBookmark: (bookmark: EnrichedBookmark) => void;
  updateBookmark: (bookmark: EnrichedBookmark) => void;
  deleteBookmark: (uri: string) => void;
  loadBookmarks: () => Promise<void>;

  // Tag actions
  setTags: (tags: EnrichedTag[]) => void;
  addTag: (tag: EnrichedTag) => void;
  updateTag: (tag: EnrichedTag) => void;
  deleteTag: (uri: string) => void;
  loadTags: () => Promise<void>;

  // Combined initial data loading (avoids token refresh race condition)
  loadInitialData: () => Promise<void>;

  // Filter actions
  toggleTag: (tagValue: string) => void;
  clearFilters: () => void;

  // Computed values
  filteredBookmarks: EnrichedBookmark[];
}

const AppContext = createContext<AppContextValue | null>(null);

export function AppProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [bookmarks, setBookmarks] = useState<EnrichedBookmark[]>([]);
  const [tags, setTags] = useState<EnrichedTag[]>([]);
  const [selectedTags, setSelectedTags] = useState<Set<string>>(new Set());
  const [loading, _setLoading] = useState(true);

  // Bookmark actions
  async function loadBookmarks() {
    try {
      const response = await apiGet("/api/bookmarks");
      if (!response.ok) {
        throw new Error("Failed to load bookmarks");
      }
      const data = await response.json();
      setBookmarks(data.bookmarks);
    } catch (err) {
      console.error("Failed to load bookmarks:", err);
      throw err;
    }
  }

  function addBookmark(bookmark: EnrichedBookmark) {
    setBookmarks((prev) => [bookmark, ...prev]);
  }

  function updateBookmark(bookmark: EnrichedBookmark) {
    setBookmarks((prev) =>
      prev.map((b) => b.uri === bookmark.uri ? bookmark : b)
    );
  }

  function deleteBookmark(uri: string) {
    setBookmarks((prev) => prev.filter((b) => b.uri !== uri));
  }

  // Tag actions
  async function loadTags() {
    try {
      const response = await apiGet("/api/tags");
      if (!response.ok) {
        throw new Error("Failed to load tags");
      }
      const data = await response.json();
      setTags(data.tags);
    } catch (err) {
      console.error("Failed to load tags:", err);
      throw err;
    }
  }

  function addTag(tag: EnrichedTag) {
    setTags((prev) => [tag, ...prev]);
  }

  function updateTag(tag: EnrichedTag) {
    setTags((prev) => prev.map((t) => t.uri === tag.uri ? tag : t));
  }

  function deleteTag(uri: string) {
    setTags((prev) => prev.filter((t) => t.uri !== uri));
  }

  // Combined initial data loading (avoids token refresh race condition)
  async function loadInitialData() {
    try {
      const response = await apiGet("/api/initial-data");
      if (!response.ok) {
        throw new Error("Failed to load initial data");
      }
      const data: InitialDataResponse = await response.json();
      setBookmarks(data.bookmarks);
      setTags(data.tags);
    } catch (err) {
      console.error("Failed to load initial data:", err);
      throw err;
    }
  }

  // Filter actions
  function toggleTag(tagValue: string) {
    setSelectedTags((prev) => {
      const newSet = new Set(prev);
      if (newSet.has(tagValue)) {
        newSet.delete(tagValue);
      } else {
        newSet.add(tagValue);
      }
      return newSet;
    });
  }

  function clearFilters() {
    setSelectedTags(new Set());
  }

  // Computed values
  const filteredBookmarks = selectedTags.size === 0
    ? bookmarks
    : bookmarks.filter((bookmark) =>
      [...selectedTags].every((tag) => bookmark.tags?.includes(tag))
    );

  const value: AppContextValue = {
    // State
    session,
    bookmarks,
    tags,
    selectedTags,
    loading,

    // Session actions
    setSession,

    // Bookmark actions
    setBookmarks,
    addBookmark,
    updateBookmark,
    deleteBookmark,
    loadBookmarks,

    // Tag actions
    setTags,
    addTag,
    updateTag,
    deleteTag,
    loadTags,

    // Combined initial data loading
    loadInitialData,

    // Filter actions
    toggleTag,
    clearFilters,

    // Computed values
    filteredBookmarks,
  };

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp() {
  const context = useContext(AppContext);
  if (!context) {
    throw new Error("useApp must be used within AppProvider");
  }
  return context;
}
