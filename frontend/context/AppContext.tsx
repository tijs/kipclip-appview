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
  ListTagsResponse,
  SessionInfo,
  UserPreferences,
  UserSettings,
} from "../../shared/types.ts";
import { getDateFormat, setDateFormat } from "../../shared/date-format.ts";
import { apiGet, apiPatch, apiPost, apiPut } from "../utils/api.ts";
import type { SupporterStatusResponse } from "../../shared/types.ts";
import { perf } from "../perf.ts";
import { toast } from "sonner";
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

// PDS-fallback throttle: pause pagination when remaining calls drop below
// this threshold to avoid the 30-min lockout this whole migration was
// designed to prevent. Same threshold as the pre-phase-4 sync layer.
const RATE_LIMIT_THRESHOLD = 50;

interface PaginatedInitial {
  bookmarks: EnrichedBookmark[];
  settings: UserSettings;
  preferences: UserPreferences;
  isSupporter: boolean;
  /** Mirror branch only: true while backfill is still in progress. */
  syncing: boolean;
}

/**
 * Fetch /api/initial-data and walk every bookmarkCursor page until the
 * server omits it. Both the mirror branch and the PDS-fallback branch
 * paginate the same way; the PDS branch additionally returns
 * annotationCursor + rateLimit on each page, which we forward and honor.
 *
 * Settings / preferences / isSupporter / syncing are taken only from the
 * first response — subsequent pages do not re-emit them.
 */
async function fetchInitialPaginated(
  onProgress?: (page: number) => void,
): Promise<PaginatedInitial> {
  perf.start("initialDataPaginated");
  const firstResponse = await apiGet("/api/initial-data");
  if (!firstResponse.ok) {
    const body = await firstResponse.text().catch(() => "");
    throw new Error(
      `Failed to load initial data: ${firstResponse.status} ${body}`,
    );
  }
  const first: InitialDataResponse = await firstResponse.json();

  const bookmarks: EnrichedBookmark[] = [...first.bookmarks];
  let bookmarkCursor = first.bookmarkCursor;
  let annotationCursor = first.annotationCursor;
  let currentRateLimit = first.rateLimit;
  let pageNumber = 1;

  while (bookmarkCursor) {
    pageNumber++;
    onProgress?.(pageNumber);

    if (currentRateLimit && currentRateLimit.remaining < RATE_LIMIT_THRESHOLD) {
      const waitMs = Math.max(0, currentRateLimit.reset * 1000 - Date.now()) +
        500;
      console.warn("PDS rate limit low, pausing sync", {
        remaining: currentRateLimit.remaining,
        waitMs,
      });
      await new Promise((r) => setTimeout(r, waitMs));
    }

    const params = new URLSearchParams();
    params.set("bookmarkCursor", bookmarkCursor);
    if (annotationCursor) params.set("annotationCursor", annotationCursor);

    const response = await apiGet(`/api/initial-data?${params}`);
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(
        `Failed to load page ${pageNumber}: ${response.status} ${body}`,
      );
    }
    const page: InitialDataResponse = await response.json();
    if (page.rateLimit) currentRateLimit = page.rateLimit;
    if (page.bookmarks?.length > 0) bookmarks.push(...page.bookmarks);
    bookmarkCursor = page.bookmarkCursor;
    annotationCursor = page.annotationCursor;
  }

  // Newest-first ordering across all merged pages.
  bookmarks.sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  perf.end("initialDataPaginated");
  return {
    bookmarks,
    settings: first.settings,
    preferences: first.preferences,
    isSupporter: first.isSupporter,
    syncing: first.syncing ?? false,
  };
}

/**
 * Fetch /api/tags. Fail-soft so a transient tag-fetch error does not block
 * the bookmark render path (we fire bookmarks + tags in parallel).
 */
async function fetchTagsList(): Promise<EnrichedTag[]> {
  perf.start("tagsFetch");
  try {
    const response = await apiGet("/api/tags");
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      console.warn(`fetchTags: ${response.status} ${body}`);
      return [];
    }
    const data = (await response.json()) as ListTagsResponse;
    return data.tags ?? [];
  } catch (err) {
    console.warn("fetchTags: network error", err);
    return [];
  } finally {
    perf.end("tagsFetch");
  }
}

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
  isSupporter: boolean;
  /**
   * Server-reported mirror-backfill flag. True when /api/initial-data was
   * served from the mirror but backfill is still running for this DID.
   * Wired through to context so a follow-up can render an in-progress
   * indicator without another AppContext change.
   */
  mirrorSyncing: boolean;
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
  // Force a full refresh, paginating through every page.
  refreshData: (toastId?: string | number) => Promise<void>;

  // Filter actions
  toggleTag: (tagValue: string) => void;
  clearFilters: () => void;

  // Supporter actions
  refreshSupporterStatus: () => Promise<boolean>;

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

  // Sync state (in-flight indicator for the loading spinner)
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
  const [isSupporter, setIsSupporter] = useState(false);
  const [mirrorSyncing, setMirrorSyncing] = useState(false);

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
    const tagsList = await fetchTagsList();
    setTags(tagsList);
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

  /** Apply settings/preferences/isSupporter from the first /api/initial-data response. */
  function applyServerMeta(data: PaginatedInitial) {
    setSettings(data.settings);
    setIsSupporter(data.isSupporter);
    setMirrorSyncing(data.syncing);
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
   * Load initial bookmarks + tags from the AppView, paginating through
   * every page in a unified loop. No client-side cache: an AppView outage
   * surfaces as a hard error rather than a stale-cache render. See plan
   * 2026-05-05-001-refactor-phase-4 for the accepted regression.
   */
  async function loadInitialData() {
    perf.start("loadInitialData");
    setIsSyncing(true);
    try {
      const [data, tagsList] = await Promise.all([
        fetchInitialPaginated(),
        fetchTagsList(),
      ]);
      applyServerMeta(data);
      setBookmarks(data.bookmarks);
      setTags(tagsList);
    } catch (err) {
      console.error("Failed to load initial data:", err);
      throw err;
    } finally {
      setIsSyncing(false);
      perf.end("loadInitialData");
    }
  }

  // Manual refresh: full re-fetch + repaginate. Guarded so visibilitychange
  // and pull-to-refresh can both call it without racing.
  const refreshInFlightRef = useRef(false);
  async function refreshData(toastId?: string | number) {
    if (refreshInFlightRef.current) return;
    refreshInFlightRef.current = true;
    setIsSyncing(true);
    try {
      const [data, tagsList] = await Promise.all([
        fetchInitialPaginated((page) => {
          if (toastId) {
            toast(`Syncing bookmarks... (page ${page})`, { id: toastId });
          }
        }),
        fetchTagsList(),
      ]);
      applyServerMeta(data);
      setBookmarks(data.bookmarks);
      setTags(tagsList);
      if (toastId) {
        toast.success("Bookmarks up to date", { id: toastId });
      }
    } finally {
      refreshInFlightRef.current = false;
      setIsSyncing(false);
    }
  }

  // Tab re-focus: refetch (debounced 60s). Mirror reads are cheap but
  // mobile foreground transitions can fire many visibility events in a
  // burst — debounce keeps the network quiet.
  const lastSyncCheckRef = useRef(Date.now());
  useEffect(() => {
    if (!session) return;

    function handleVisibilityChange() {
      if (document.visibilityState !== "visible") return;
      const now = Date.now();
      if (now - lastSyncCheckRef.current < 60_000) return;
      lastSyncCheckRef.current = now;
      refreshData().catch((err) => {
        console.warn("Tab-focus sync failed:", err);
      });
    }

    function handlePageShow(e: PageTransitionEvent) {
      if (e.persisted) handleVisibilityChange();
    }

    document.addEventListener("visibilitychange", handleVisibilityChange);
    globalThis.addEventListener("pageshow", handlePageShow);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      globalThis.removeEventListener("pageshow", handlePageShow);
    };
  }, [session]);

  // Supporter actions
  async function refreshSupporterStatus(): Promise<boolean> {
    const response = await apiGet("/api/user/supporter-status");
    if (!response.ok) {
      throw new Error("Failed to refresh supporter status");
    }
    const data: SupporterStatusResponse = await response.json();
    setIsSupporter(data.isSupporter);
    return data.isSupporter;
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
    isSupporter,
    mirrorSyncing,
    refreshSupporterStatus,
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
