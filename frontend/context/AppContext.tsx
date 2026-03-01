import {
  createContext,
  type ReactNode,
  useCallback,
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
  UserPreferences,
  UserSettings,
} from "../../shared/types.ts";
import { getDateFormat, setDateFormat } from "../../shared/date-format.ts";
import { apiGet, apiPatch, apiPost, apiPut } from "../utils/api.ts";
import {
  deleteBookmarkFromCache,
  deleteTagFromCache,
  openCacheDb,
  putBookmark as putBookmarkToCache,
  putTag as putTagToCache,
} from "../cache/db.ts";
import { checkForChanges, loadWithCache } from "../cache/sync.ts";

// Search helper: case-insensitive match across searchable fields
function matchesSearch(bookmark: EnrichedBookmark, query: string): boolean {
  const q = query.toLowerCase();
  return (
    bookmark.title?.toLowerCase().includes(q) ||
    bookmark.description?.toLowerCase().includes(q) ||
    bookmark.subject.toLowerCase().includes(q) ||
    bookmark.note?.toLowerCase().includes(q) ||
    bookmark.tags?.some((tag) => tag.toLowerCase().includes(q)) ||
    false
  );
}

const DEFAULT_SETTINGS: UserSettings = {
  instapaperEnabled: false,
};

const DEFAULT_PREFERENCES: UserPreferences = {
  dateFormat: "us",
  readingListTag: "toread",
};

interface AppState {
  session: SessionInfo | null;
  bookmarks: EnrichedBookmark[];
  tags: EnrichedTag[];
  selectedTags: Set<string>;
  settings: UserSettings;
  preferences: UserPreferences;
  readingListSelectedTags: Set<string>;
  loading: boolean;
  bookmarkSearchQuery: string;
  readingListSearchQuery: string;
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

  // Preferences actions
  updatePreferences: (updates: Partial<UserPreferences>) => Promise<void>;

  // Reading list filter actions
  toggleReadingListTag: (tagValue: string) => void;
  clearReadingListFilters: () => void;

  // Search actions
  setBookmarkSearchQuery: (query: string) => void;
  setReadingListSearchQuery: (query: string) => void;

  // Computed values
  totalBookmarks: number;
  totalReadingList: number;
  filteredBookmarks: EnrichedBookmark[];
  readingListBookmarks: EnrichedBookmark[];
  readingListTags: string[];
  filteredReadingList: EnrichedBookmark[];
}

const AppContext = createContext<AppContextValue | null>(null);

export function AppProvider({ children }: { children: ReactNode }) {
  const [session, setSessionRaw] = useState<SessionInfo | null>(null);
  const [bookmarks, setBookmarks] = useState<EnrichedBookmark[]>([]);
  const [tags, setTagsRaw] = useState<EnrichedTag[]>([]);
  const sortTags = (t: EnrichedTag[]) =>
    [...t].sort((a, b) => a.value.localeCompare(b.value));
  const setTags = (
    update: EnrichedTag[] | ((prev: EnrichedTag[]) => EnrichedTag[]),
  ) => {
    if (typeof update === "function") {
      setTagsRaw((prev) => sortTags(update(prev)));
    } else {
      setTagsRaw(sortTags(update));
    }
  };
  const [selectedTags, setSelectedTags] = useState<Set<string>>(new Set());
  const [settings, setSettings] = useState<UserSettings>(DEFAULT_SETTINGS);
  const [preferences, setPreferences] = useState<UserPreferences>(
    DEFAULT_PREFERENCES,
  );
  const [readingListSelectedTags, setReadingListSelectedTags] = useState<
    Set<string>
  >(new Set());
  const [loading, _setLoading] = useState(true);
  const [bookmarkSearchQuery, setBookmarkSearchQuery] = useState(() => {
    const params = new URLSearchParams(globalThis.location.search);
    return params.get("q") || "";
  });
  const [readingListSearchQuery, setReadingListSearchQuery] = useState("");

  const setSession = useCallback((s: SessionInfo | null) => {
    setSessionRaw(s);
  }, []);

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
    putBookmarkToCache(bookmark).catch(() => {});
  }

  function updateBookmark(bookmark: EnrichedBookmark) {
    setBookmarks((prev) =>
      prev.map((b) => b.uri === bookmark.uri ? bookmark : b)
    );
    putBookmarkToCache(bookmark).catch(() => {});
  }

  function deleteBookmark(uri: string) {
    setBookmarks((prev) => prev.filter((b) => b.uri !== uri));
    deleteBookmarkFromCache(uri).catch(() => {});
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
    putTagToCache(tag).catch(() => {});
  }

  function updateTag(tag: EnrichedTag) {
    setTags((prev) => prev.map((t) => t.uri === tag.uri ? tag : t));
    putTagToCache(tag).catch(() => {});
  }

  function deleteTag(uri: string) {
    setTags((prev) => prev.filter((t) => t.uri !== uri));
    deleteTagFromCache(uri).catch(() => {});
  }

  /** Apply settings/preferences from server response */
  function applyServerMeta(data: InitialDataResponse) {
    setSettings(data.settings);
    if (data.preferences) {
      const localFormat = getDateFormat();
      const pdsFormat = data.preferences.dateFormat;
      if (localFormat !== "us" && pdsFormat === "us") {
        setPreferences({ ...data.preferences, dateFormat: localFormat });
        apiPut("/api/preferences", { dateFormat: localFormat }).catch(() => {});
      } else {
        setPreferences(data.preferences);
        setDateFormat(pdsFormat as any);
      }
    }
  }

  // Combined initial data loading with cache-first strategy
  async function loadInitialData() {
    try {
      // Open IndexedDB before reading cache (must await to avoid race)
      if (session) {
        await openCacheDb(session.did);
      }

      const { immediate, refresh } = await loadWithCache();

      if (immediate) {
        // Cache hit: populate state immediately and return.
        // dataLoading goes false in App.tsx, UI shows cached data.
        setBookmarks(immediate.bookmarks);
        setTags(immediate.tags);

        // Background refresh: update state if data changed on server
        refresh.then((data) => {
          if (!data._unchanged) {
            setBookmarks(data.bookmarks);
            setTags(data.tags);
          }
          applyServerMeta(data);
        }).catch((err) => console.error("Background refresh failed:", err));
        return;
      }

      // No cache: wait for full server fetch (spinner stays visible)
      const data = await refresh;
      setBookmarks(data.bookmarks);
      setTags(data.tags);
      applyServerMeta(data);
    } catch (err) {
      console.error("Failed to load initial data:", err);
      throw err;
    }
  }

  // Tab re-focus: check for changes and refresh if needed (debounced)
  const lastSyncCheckRef = useRef(0);
  useEffect(() => {
    if (!session) return;

    function handleVisibilityChange() {
      if (document.visibilityState !== "visible") return;
      const now = Date.now();
      if (now - lastSyncCheckRef.current < 60_000) return; // max once per 60s
      lastSyncCheckRef.current = now;

      checkForChanges().then((changed) => {
        if (changed) {
          loadInitialData().catch((err) =>
            console.error("Tab-refocus refresh failed:", err)
          );
        }
      }).catch(() => {});
    }

    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () =>
      document.removeEventListener("visibilitychange", handleVisibilityChange);
  }, [session]);

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

  // Preferences actions
  async function updatePreferences(updates: Partial<UserPreferences>) {
    setPreferences((prev) => ({ ...prev, ...updates }));
    if (updates.dateFormat) {
      setDateFormat(updates.dateFormat as any);
    }

    try {
      const response = await apiPut("/api/preferences", updates);
      if (!response.ok) {
        throw new Error("Failed to update preferences");
      }
      const data = await response.json();
      if (data.preferences) {
        setPreferences(data.preferences);
      }
    } catch {
      // PDS write failed — optimistic update already applied
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
  const filteredBookmarks = useMemo(() => {
    let result = bookmarks;

    if (selectedTags.size > 0) {
      result = result.filter((bookmark) =>
        [...selectedTags].every((tag) =>
          bookmark.tags?.some((t) => t.toLowerCase() === tag.toLowerCase())
        )
      );
    }

    if (bookmarkSearchQuery.trim()) {
      result = result.filter((b) => matchesSearch(b, bookmarkSearchQuery));
    }

    return result;
  }, [bookmarks, selectedTags, bookmarkSearchQuery]);

  const readingListBookmarks = useMemo(
    () => {
      const rlLower = preferences.readingListTag.toLowerCase();
      return bookmarks.filter((b) =>
        b.tags?.some((t) => t.toLowerCase() === rlLower)
      );
    },
    [bookmarks, preferences.readingListTag],
  );

  const readingListTags = useMemo(() => {
    const tagSet = new Set<string>();
    readingListBookmarks.forEach((b) => b.tags?.forEach((t) => tagSet.add(t)));
    const tagArray = Array.from(tagSet);
    return tagArray.sort((a, b) => {
      if (a === preferences.readingListTag) return -1;
      if (b === preferences.readingListTag) return 1;
      return a.localeCompare(b);
    });
  }, [readingListBookmarks, preferences.readingListTag]);

  const filteredReadingList = useMemo(() => {
    let result = readingListBookmarks;

    if (readingListSelectedTags.size > 0) {
      result = result.filter((b) =>
        [...readingListSelectedTags].every((tag) =>
          b.tags?.some((t) => t.toLowerCase() === tag.toLowerCase())
        )
      );
    }

    if (readingListSearchQuery.trim()) {
      result = result.filter((b) => matchesSearch(b, readingListSearchQuery));
    }

    return result;
  }, [readingListBookmarks, readingListSelectedTags, readingListSearchQuery]);

  // Track which bookmarks are currently being enriched (in-flight requests)
  const enrichingRef = useRef<Set<string>>(new Set());
  const failedAttemptsRef = useRef<Map<string, number>>(new Map());
  const MAX_ENRICHMENT_RETRIES = 3;

  // Background re-enrichment for reading list bookmarks missing images
  useEffect(() => {
    const bookmarksNeedingEnrichment = readingListBookmarks.filter((b) => {
      if (b.image) return false;
      if (enrichingRef.current.has(b.uri)) return false;
      const attempts = failedAttemptsRef.current.get(b.uri) || 0;
      return attempts < MAX_ENRICHMENT_RETRIES;
    });

    if (bookmarksNeedingEnrichment.length === 0) return;

    const enrichBatch = async () => {
      const batch = bookmarksNeedingEnrichment.slice(0, 3);

      for (const bookmark of batch) {
        enrichingRef.current.add(bookmark.uri);

        try {
          const rkey = bookmark.uri.split("/").pop();
          if (!rkey) {
            enrichingRef.current.delete(bookmark.uri);
            continue;
          }

          const response = await apiPost(`/api/bookmarks/${rkey}/enrich`);
          if (response.ok) {
            const data = await response.json();
            if (data.bookmark) {
              updateBookmark(data.bookmark);
              failedAttemptsRef.current.delete(bookmark.uri);
            }
          } else {
            const attempts = failedAttemptsRef.current.get(bookmark.uri) || 0;
            failedAttemptsRef.current.set(bookmark.uri, attempts + 1);
          }
        } catch (err) {
          console.error("Failed to enrich bookmark:", err);
          const attempts = failedAttemptsRef.current.get(bookmark.uri) || 0;
          failedAttemptsRef.current.set(bookmark.uri, attempts + 1);
        } finally {
          enrichingRef.current.delete(bookmark.uri);
        }
      }
    };

    const timeoutId = setTimeout(enrichBatch, 1000);
    return () => clearTimeout(timeoutId);
  }, [readingListBookmarks]);

  const value: AppContextValue = {
    session,
    bookmarks,
    tags,
    selectedTags,
    settings,
    preferences,
    readingListSelectedTags,
    loading,
    bookmarkSearchQuery,
    readingListSearchQuery,
    setSession,
    setBookmarks,
    addBookmark,
    updateBookmark,
    deleteBookmark,
    loadBookmarks,
    setTags,
    addTag,
    updateTag,
    deleteTag,
    loadTags,
    loadInitialData,
    toggleTag,
    clearFilters,
    updateSettings,
    updatePreferences,
    toggleReadingListTag,
    clearReadingListFilters,
    setBookmarkSearchQuery,
    setReadingListSearchQuery,
    totalBookmarks: bookmarks.length,
    totalReadingList: readingListBookmarks.length,
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
