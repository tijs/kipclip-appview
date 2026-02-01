import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  EnrichedBookmark,
  EnrichedTag,
  InitialDataResponse,
  SessionInfo,
  UserSettings,
} from "../../shared/types.ts";
import { apiGet, apiPatch, apiPost } from "../utils/api.ts";

const DEFAULT_SETTINGS: UserSettings = {
  readingListTag: "toread",
  instapaperEnabled: false,
};

interface AppState {
  session: SessionInfo | null;
  bookmarks: EnrichedBookmark[];
  tags: EnrichedTag[];
  selectedTags: Set<string>;
  settings: UserSettings;
  readingListSelectedTags: Set<string>;
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

  // Settings actions
  updateSettings: (updates: Partial<UserSettings>) => Promise<void>;

  // Reading list filter actions
  toggleReadingListTag: (tagValue: string) => void;
  clearReadingListFilters: () => void;

  // Computed values
  filteredBookmarks: EnrichedBookmark[];
  readingListBookmarks: EnrichedBookmark[];
  readingListTags: string[];
  filteredReadingList: EnrichedBookmark[];
}

const AppContext = createContext<AppContextValue | null>(null);

export function AppProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [bookmarks, setBookmarks] = useState<EnrichedBookmark[]>([]);
  const [tags, setTags] = useState<EnrichedTag[]>([]);
  const [selectedTags, setSelectedTags] = useState<Set<string>>(new Set());
  const [settings, setSettings] = useState<UserSettings>(DEFAULT_SETTINGS);
  const [readingListSelectedTags, setReadingListSelectedTags] = useState<
    Set<string>
  >(new Set());
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
      setSettings(data.settings);
    } catch (err) {
      console.error("Failed to load initial data:", err);
      throw err;
    }
  }

  // Settings actions
  async function updateSettings(updates: Partial<UserSettings>) {
    try {
      const response = await apiPatch("/api/settings", updates);
      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || "Failed to update settings");
      }
      const data = await response.json();
      if (data.settings) {
        setSettings(data.settings);
      }
    } catch (err) {
      console.error("Failed to update settings:", err);
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

  // Reading list filter actions
  function toggleReadingListTag(tagValue: string) {
    setReadingListSelectedTags((prev) => {
      const newSet = new Set(prev);
      if (newSet.has(tagValue)) {
        newSet.delete(tagValue);
      } else {
        newSet.add(tagValue);
      }
      return newSet;
    });
  }

  function clearReadingListFilters() {
    setReadingListSelectedTags(new Set());
  }

  // Computed values
  const filteredBookmarks = selectedTags.size === 0
    ? bookmarks
    : bookmarks.filter((bookmark) =>
      [...selectedTags].every((tag) => bookmark.tags?.includes(tag))
    );

  // Reading list: bookmarks with the configured reading list tag
  const readingListBookmarks = useMemo(
    () => bookmarks.filter((b) => b.tags?.includes(settings.readingListTag)),
    [bookmarks, settings.readingListTag],
  );

  // Tags that appear on reading list bookmarks
  const readingListTags = useMemo(() => {
    const tagSet = new Set<string>();
    readingListBookmarks.forEach((b) => b.tags?.forEach((t) => tagSet.add(t)));
    // Sort to show reading list tag first, then alphabetically
    const tagArray = Array.from(tagSet);
    return tagArray.sort((a, b) => {
      if (a === settings.readingListTag) return -1;
      if (b === settings.readingListTag) return 1;
      return a.localeCompare(b);
    });
  }, [readingListBookmarks, settings.readingListTag]);

  // Filtered reading list based on additional tag selection
  const filteredReadingList = useMemo(() => {
    if (readingListSelectedTags.size === 0) return readingListBookmarks;
    return readingListBookmarks.filter((b) =>
      [...readingListSelectedTags].every((tag) => b.tags?.includes(tag))
    );
  }, [readingListBookmarks, readingListSelectedTags]);

  // Track which bookmarks are being enriched to avoid duplicate requests
  const enrichingRef = useRef<Set<string>>(new Set());

  // Background re-enrichment for reading list bookmarks missing images
  useEffect(() => {
    const bookmarksNeedingEnrichment = readingListBookmarks.filter(
      (b) => !b.image && !enrichingRef.current.has(b.uri),
    );

    if (bookmarksNeedingEnrichment.length === 0) return;

    // Rate-limit: enrich up to 3 bookmarks at a time with delay between batches
    const enrichBatch = async () => {
      const batch = bookmarksNeedingEnrichment.slice(0, 3);

      for (const bookmark of batch) {
        enrichingRef.current.add(bookmark.uri);

        try {
          // Extract rkey from URI: at://did/collection/rkey
          const rkey = bookmark.uri.split("/").pop();
          if (!rkey) continue;

          const response = await apiPost(`/api/bookmarks/${rkey}/enrich`);
          if (response.ok) {
            const data = await response.json();
            if (data.bookmark) {
              updateBookmark(data.bookmark);
            }
          }
        } catch (err) {
          console.error("Failed to enrich bookmark:", err);
        }
      }
    };

    // Delay slightly to not block initial render
    const timeoutId = setTimeout(enrichBatch, 1000);
    return () => clearTimeout(timeoutId);
  }, [readingListBookmarks]);

  const value: AppContextValue = {
    // State
    session,
    bookmarks,
    tags,
    selectedTags,
    settings,
    readingListSelectedTags,
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

    // Settings actions
    updateSettings,

    // Reading list filter actions
    toggleReadingListTag,
    clearReadingListFilters,

    // Computed values
    filteredBookmarks,
    readingListBookmarks,
    readingListTags,
    filteredReadingList,
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
