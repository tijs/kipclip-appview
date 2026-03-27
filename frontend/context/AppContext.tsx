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
  UserPreferences,
  UserSettings,
} from "../../shared/types.ts";
import { getDateFormat, setDateFormat } from "../../shared/date-format.ts";
import { apiGet, apiPatch, apiPost, apiPut } from "../utils/api.ts";
import { perf } from "../perf.ts";
import {
  deleteBookmarkFromCache,
  deleteTagFromCache,
  getCachedBookmarks,
  getCachedTags,
  openCacheDb,
  putBookmark as putBookmarkToCache,
  putBookmarks,
  putTag as putTagToCache,
  putTags,
  upsertBookmarks,
} from "../cache/db.ts";
import {
  fetchFirstPage,
  loadRemainingPages,
  writeToCache,
} from "../cache/sync.ts";
import { mergeFirstPageDiff } from "../cache/diff.ts";
import {
  buildTagIndex,
  filterByTags,
  matchesSearch,
} from "../../shared/bookmark-filters.ts";
import {
  parseSearchQuery,
  toggleTagInQuery,
} from "../../shared/search-query.ts";

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
  // Force a full refresh (bypasses cache, fetches all pages)
  refreshData: () => Promise<void>;

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

  // Sync state
  isSyncing: boolean;

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
  const [session, setSession] = useState<SessionInfo | null>(null);
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
  const [settings, setSettings] = useState<UserSettings>(DEFAULT_SETTINGS);
  const [preferences, setPreferences] = useState<UserPreferences>(
    DEFAULT_PREFERENCES,
  );
  const [readingListSelectedTags, setReadingListSelectedTags] = useState<
    Set<string>
  >(new Set());
  const [bookmarkSearchQuery, setBookmarkSearchQuery] = useState(() => {
    const params = new URLSearchParams(globalThis.location.search);
    return params.get("q") || "";
  });
  const [readingListSearchQuery, setReadingListSearchQuery] = useState("");
  const [isSyncing, setIsSyncing] = useState(false);

  // Ref to current bookmarks for race-condition-safe merging during sync.
  const bookmarksRef = useRef<EnrichedBookmark[]>([]);
  useEffect(() => {
    bookmarksRef.current = bookmarks;
  }, [bookmarks]);

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

  /**
   * Load initial data with cache-first strategy + first-page diff.
   *
   * Cache hit: show cached data immediately, then fetch first page in
   * background and diff URIs+CIDs to find additions/edits. Upsert
   * changes into cache without re-fetching everything.
   *
   * Cache miss: fetch first page, render immediately, then paginate
   * remaining pages in background with rate-limit-aware throttling.
   */
  async function loadInitialData() {
    perf.start("loadInitialData");
    setIsSyncing(true);

    try {
      if (session) {
        await openCacheDb(session.did);
      }

      const [cachedBookmarks, cachedTags] = await Promise.all([
        getCachedBookmarks(),
        getCachedTags(),
      ]);
      const hasCache = cachedBookmarks !== null && cachedTags !== null;

      if (hasCache) {
        // Cache hit: render immediately
        setBookmarks(cachedBookmarks);
        setTags(cachedTags);

        // Background: fetch first page and diff against cache
        try {
          const data = await fetchFirstPage();
          applyServerMeta(data);
          setTags(data.tags);
          putTags(data.tags).catch(() => {});

          // All bookmarks deleted on another device → clear local cache
          if (data.bookmarks.length === 0 && !data.bookmarkCursor) {
            setBookmarks([]);
            putBookmarks([]).catch(() => {});
            return;
          }

          const result = mergeFirstPageDiff(
            data.bookmarks,
            bookmarksRef.current,
          );
          if (result) {
            setBookmarks(result.merged);
            upsertBookmarks(result.changed).catch(() => {});
          }
        } catch {
          // First-page fetch failed — keep cache as-is, retry on next focus
        }
      } else {
        // Cache miss (cold start): fetch first page, render, paginate rest
        const data = await fetchFirstPage();
        applyServerMeta(data);

        // Render first page immediately
        setBookmarks(data.bookmarks);
        setTags(data.tags);

        if (data.bookmarkCursor) {
          // Paginate remaining pages in background
          const result = await loadRemainingPages(data);
          if (result.complete) {
            setBookmarks(result.bookmarks);
          }
          // Write full set to cache
          await writeToCache({
            bookmarks: result.complete ? result.bookmarks : data.bookmarks,
            tags: data.tags,
          });
        } else {
          // Only one page — write directly
          await writeToCache({ bookmarks: data.bookmarks, tags: data.tags });
        }
      }
    } catch (err) {
      console.error("Failed to load initial data:", err);
      throw err;
    } finally {
      setIsSyncing(false);
      perf.end("loadInitialData");
    }
  }

  // Manual refresh: full fetch from server with rate-limit-aware pagination.
  // Guarded against concurrent calls to protect PDS rate limits.
  const refreshInFlightRef = useRef(false);
  async function refreshData() {
    if (refreshInFlightRef.current) return;
    refreshInFlightRef.current = true;
    setIsSyncing(true);
    try {
      const data = await fetchFirstPage();
      applyServerMeta(data);
      const result = await loadRemainingPages(data);
      if (result.complete) {
        setBookmarks(result.bookmarks);
        setTags(data.tags);
        await writeToCache({ bookmarks: result.bookmarks, tags: data.tags });
      }
    } finally {
      refreshInFlightRef.current = false;
      setIsSyncing(false);
    }
  }

  // Tab re-focus: fetch first page and diff against cache (debounced 60s).
  // No separate sync-check — the diff itself detects changes.
  const lastSyncCheckRef = useRef(0);
  useEffect(() => {
    if (!session) return;

    function handleVisibilityChange() {
      if (document.visibilityState !== "visible") return;
      const now = Date.now();
      if (now - lastSyncCheckRef.current < 60_000) return;
      lastSyncCheckRef.current = now;

      // Re-run the same first-page diff as loadInitialData (cache-hit path).
      // This is idempotent — if nothing changed, no state updates happen.
      (async () => {
        setIsSyncing(true);
        try {
          const data = await fetchFirstPage();
          applyServerMeta(data);
          setTags(data.tags);
          putTags(data.tags).catch(() => {});

          const result = mergeFirstPageDiff(
            data.bookmarks,
            bookmarksRef.current,
          );
          if (result) {
            setBookmarks(result.merged);
            upsertBookmarks(result.changed).catch(() => {});
          }
        } catch {
          // Fetch failed — keep current state, retry on next focus
        } finally {
          setIsSyncing(false);
        }
      })();
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

  // Derive selectedTags from search query
  const parsedQuery = useMemo(
    () => parseSearchQuery(bookmarkSearchQuery),
    [bookmarkSearchQuery],
  );
  const selectedTags = useMemo(
    () => new Set(parsedQuery.tags),
    [parsedQuery.tags],
  );

  // Filter actions
  function toggleTag(tagValue: string) {
    setBookmarkSearchQuery(toggleTagInQuery(bookmarkSearchQuery, tagValue));
  }

  function clearFilters() {
    setBookmarkSearchQuery(parsedQuery.text);
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

  // Pre-normalize tags once when bookmarks change (not on every filter)
  const tagIndex = useMemo(() => buildTagIndex(bookmarks), [bookmarks]);

  // Computed values
  const filteredBookmarks = useMemo(() => {
    perf.start("tagFilter");
    let result = filterByTags(bookmarks, selectedTags, tagIndex);

    if (parsedQuery.text.trim()) {
      result = result.filter((b) => matchesSearch(b, parsedQuery.text));
    }

    perf.end("tagFilter");
    return result;
  }, [bookmarks, tagIndex, selectedTags, parsedQuery.text]);

  const readingListBookmarks = useMemo(
    () => {
      const rlLower = preferences.readingListTag.toLowerCase();
      return bookmarks.filter((b) => {
        const tags = tagIndex.get(b.uri);
        return tags !== undefined && tags.has(rlLower);
      });
    },
    [bookmarks, tagIndex, preferences.readingListTag],
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
    let result = filterByTags(
      readingListBookmarks,
      readingListSelectedTags,
      tagIndex,
    );

    if (readingListSearchQuery.trim()) {
      result = result.filter((b) => matchesSearch(b, readingListSearchQuery));
    }

    return result;
  }, [
    readingListBookmarks,
    tagIndex,
    readingListSelectedTags,
    readingListSearchQuery,
  ]);

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
    refreshData,
    toggleTag,
    clearFilters,
    updateSettings,
    updatePreferences,
    toggleReadingListTag,
    clearReadingListFilters,
    setBookmarkSearchQuery,
    setReadingListSearchQuery,
    isSyncing,
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
