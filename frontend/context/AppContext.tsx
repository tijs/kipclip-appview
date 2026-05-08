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
import { connectLiveEvents, type LiveEvent } from "../lib/live-events.ts";

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

// Defensive ceiling against a server bug returning a non-advancing cursor.
// At ~50 records/page this allows 10 000 bookmarks before stopping; far
// above any real library size. The cycle-detection branch fires first when
// the same cursor repeats; this is the belt to that suspenders.
const MAX_PAGINATION_PAGES = 200;

/**
 * Subsequent pages of /api/initial-data carry only the bookmark stream
 * (cursor + rateLimit). settings / preferences / isSupporter / syncing
 * are emitted on the first response only. Encoding the asymmetry here
 * means a typo in the cursor loop fails to type-check rather than
 * silently clobbering server meta.
 */
interface PaginationPage {
  bookmarks: EnrichedBookmark[];
  bookmarkCursor?: string;
  annotationCursor?: string;
  rateLimit?: { remaining: number; reset: number; limit: number };
}

/**
 * Streaming variant of /api/initial-data fetcher.
 *
 * Phase A — `firstPage`: fetch + return the first response synchronously.
 *   The caller applies it to state immediately so first paint happens before
 *   the rest of the user's library is on the wire.
 *
 * Phase B — `streamRemaining`: walk every bookmarkCursor page in the
 *   background, invoking `onAdditionalPage` with each chunk so the caller
 *   can append into state. Resolves once pagination ends or hits a guard.
 *
 * Settings / preferences / isSupporter / syncing are emitted on the first
 * response only.
 */
async function fetchFirstPage(): Promise<InitialDataResponse> {
  perf.start("initialDataFirstPage");
  const response = await apiGet("/api/initial-data");
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `Failed to load initial data: ${response.status} ${body}`,
    );
  }
  const first: InitialDataResponse = await response.json();
  perf.end("initialDataFirstPage");
  return first;
}

async function streamRemainingPages(
  first: InitialDataResponse,
  onAdditionalPage: (bookmarks: EnrichedBookmark[]) => void,
  onProgress?: (page: number) => void,
): Promise<{ pagesLoaded: number; totalAdded: number }> {
  perf.start("initialDataRemaining");
  let bookmarkCursor = first.bookmarkCursor;
  let annotationCursor = first.annotationCursor;
  let currentRateLimit = first.rateLimit;
  let pageNumber = 1;
  let totalAdded = 0;
  let prevCursor: string | undefined;

  while (bookmarkCursor) {
    if (bookmarkCursor === prevCursor) {
      console.warn("Pagination cursor not advancing, breaking loop", {
        cursor: bookmarkCursor,
        pageNumber,
      });
      break;
    }
    if (pageNumber >= MAX_PAGINATION_PAGES) {
      console.warn("Pagination depth ceiling reached, breaking loop", {
        pageNumber,
      });
      break;
    }
    prevCursor = bookmarkCursor;
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
    const page: PaginationPage = await response.json();
    if (page.rateLimit) currentRateLimit = page.rateLimit;
    if (page.bookmarks?.length > 0) {
      onAdditionalPage(page.bookmarks);
      totalAdded += page.bookmarks.length;
    }
    bookmarkCursor = page.bookmarkCursor;
    annotationCursor = page.annotationCursor;
  }

  perf.end("initialDataRemaining");
  return { pagesLoaded: pageNumber, totalAdded };
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
      console.warn(`fetchTagsList: ${response.status} ${body}`);
      return [];
    }
    const data = (await response.json()) as ListTagsResponse;
    return data.tags ?? [];
  } catch (err) {
    console.warn("fetchTagsList: network error", err);
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
   *
   * TODO(phase4-followup): consume this in the UI as a "still syncing your
   * data" pill within 14 days of phase 4 merging (by ~2026-05-19). If the
   * follow-up slips, remove this field rather than leaving dead context
   * state. Tracking memo:
   * memory/project_post_phase4_followups.md (item 1).
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
  // True once the first page of /api/initial-data has been applied.
  // Used by App.tsx to drop the full-screen spinner and start rendering
  // bookmarks while background pagination keeps streaming pages in.
  firstPageReady: boolean;

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
  // First-page-ready signal: flips true the moment the first page of
  // /api/initial-data is applied. App.tsx uses this to drop the full-screen
  // spinner and reveal bookmarks while background pagination keeps running.
  const [firstPageReady, setFirstPageReady] = useState(false);

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
  function applyServerMeta(data: InitialDataResponse) {
    if (data.settings) setSettings(data.settings);
    if (typeof data.isSupporter === "boolean") setIsSupporter(data.isSupporter);
    setMirrorSyncing(data.syncing ?? false);
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

  // Shared in-flight guard: prevents concurrent loadInitialData /
  // refreshData. Mount-time load, visibility refresh, pull-to-refresh,
  // and post-import refresh all funnel through the same flag.
  const refreshInFlightRef = useRef(false);

  /**
   * Streaming fetch-and-apply.
   *
   * 1. Kick off /api/tags fetch in parallel (it doesn't depend on first
   *    page).
   * 2. Await first page of /api/initial-data, apply server meta, render
   *    sorted bookmarks. Flip firstPageReady so App.tsx un-blocks paint.
   * 3. Stream remaining pages, appending into state and re-sorting per
   *    chunk.
   * 4. Tags resolve whenever they resolve and are merged in.
   */
  async function fetchAndApply(
    onProgress?: (page: number) => void,
  ): Promise<{ bookmarkCount: number; pagesLoaded: number }> {
    const tagsPromise = fetchTagsList().then((tagsList) => {
      setTags(tagsList);
    });

    const first = await fetchFirstPage();
    applyServerMeta(first);
    // Trust the server's cursor order rather than re-sorting by createdAt.
    // Mirror returns (created_at, uri) DESC; PDS-fallback returns rkey-desc
    // (reverse:true). For all-TID rkeys these are equivalent; legacy hex
    // rkeys would otherwise produce a discontinuity at every page boundary
    // (first 50 ordered by createdAt, rest by rkey).
    setBookmarks(first.bookmarks);
    setFirstPageReady(true);

    // Batched flush: stream remaining pages into a buffer, commit to state
    // either every BATCH_PAGES pages or every BATCH_INTERVAL_MS — whichever
    // hits first. Avoids the per-chunk re-render storm that drove CLS to
    // 0.97 and triggered the reading-list enrich effect on every page.
    // Constants picked from local profiling on a 3000-bookmark library:
    //   BATCH_PAGES=5 keeps the flush count under ~7 for a typical user
    //     (32 pages → 7 flushes); BATCH_PAGES=10 was visibly bursty.
    //   BATCH_INTERVAL_MS=500 catches stragglers when a network hiccup
    //     stretches a single page past the per-page cadence.
    const BATCH_PAGES = 5;
    const BATCH_INTERVAL_MS = 500;
    const pending: EnrichedBookmark[] = [];
    let pagesSinceFlush = 0;
    let flushTimer: number | undefined;

    const flush = () => {
      if (flushTimer !== undefined) {
        clearTimeout(flushTimer);
        flushTimer = undefined;
      }
      if (pending.length === 0) return;
      const chunk = pending.splice(0, pending.length);
      pagesSinceFlush = 0;
      // Append-only, no re-sort. See comment above: server cursor order is
      // already globally consistent so concat preserves it.
      setBookmarks((prev) => prev.concat(chunk));
    };

    let pagesLoaded = 1;
    let totalAdded = 0;
    try {
      const result = await streamRemainingPages(
        first,
        (chunk) => {
          pending.push(...chunk);
          pagesSinceFlush++;
          if (pagesSinceFlush >= BATCH_PAGES) {
            flush();
          } else if (flushTimer === undefined) {
            flushTimer = setTimeout(flush, BATCH_INTERVAL_MS);
          }
        },
        onProgress,
      );
      pagesLoaded = result.pagesLoaded;
      totalAdded = result.totalAdded;
    } finally {
      // Always commit the buffered tail. Without this, a network blip on
      // page N would silently drop the last <BATCH_PAGES pages of buffered
      // bookmarks — user sees a partial library + an error toast and
      // assumes data was lost.
      flush();
    }

    await tagsPromise;
    return {
      bookmarkCount: first.bookmarks.length + totalAdded,
      pagesLoaded,
    };
  }

  /**
   * Load initial bookmarks + tags from the AppView, paginating through
   * every page in a unified loop. No client-side cache: an AppView outage
   * surfaces as a hard error rather than a stale-cache render. See plan
   * 2026-05-05-001-refactor-phase-4 for the accepted regression.
   */
  async function loadInitialData() {
    if (refreshInFlightRef.current) return;
    refreshInFlightRef.current = true;
    // Reset firstPageReady so a retry after a load error re-shows the
    // full-screen spinner instead of leaving the prior partial library
    // visible while the new fetch is in flight.
    setFirstPageReady(false);
    perf.start("loadInitialData");
    setIsSyncing(true);
    let pagesLoaded = 0;
    let bookmarkCount = 0;
    try {
      const result = await fetchAndApply((page) => {
        pagesLoaded = page;
      });
      bookmarkCount = result.bookmarkCount;
      pagesLoaded = result.pagesLoaded;
    } catch (err) {
      console.error("Failed to load initial data:", err);
      throw err;
    } finally {
      refreshInFlightRef.current = false;
      setIsSyncing(false);
      perf.end("loadInitialData");
      // Ship perf bundle once initial load lands. Subsequent activity
      // (INP, late CLS) is captured by the pagehide flush in perf.ts.
      perf.flush({
        bookmarks: bookmarkCount,
        pagesLoaded: pagesLoaded || 1,
        visibility: "load",
      });
    }
  }

  // Manual refresh: full re-fetch + repaginate. Shares refreshInFlightRef
  // with loadInitialData so visibilitychange + pull-to-refresh + initial
  // mount can't race each other.
  async function refreshData(toastId?: string | number) {
    if (refreshInFlightRef.current) return;
    refreshInFlightRef.current = true;
    setIsSyncing(true);
    try {
      await fetchAndApply((page) => {
        if (toastId) {
          toast(`Syncing bookmarks... (page ${page})`, { id: toastId });
        }
      });
      if (toastId) {
        toast.success("Bookmarks up to date", { id: toastId });
      }
    } catch (err) {
      // Mid-pagination failure: dismiss the progress toast and surface an
      // error one. Without this the "Syncing... (page N)" toast leaks.
      if (toastId) {
        toast.error("Refresh failed", { id: toastId });
      }
      throw err;
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
      // Don't claim the 60s window if a refresh is already running —
      // otherwise a short-circuited call would consume the slot and the
      // user would wait another full window for the next refresh attempt.
      if (refreshInFlightRef.current) return;
      lastSyncCheckRef.current = now;
      refreshData().catch((err) => {
        console.warn("Tab-focus sync failed:", err);
        toast.error("Sync failed");
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

  // Live event channel: server pushes mirror-applied TAP events for the
  // authenticated DID. Re-fetches the affected slice so sibling-collection
  // mutations (e.g. tag counts after a bookmark edit) and PDS-side edits
  // from another device propagate without a manual refresh.
  //
  // The in-flight refs collapse overlapping live-driven refetches into one.
  // Without them, two bursts arriving 101ms apart (each carrying both a
  // tag and a bookmark event) would fire 4 fetches; with them, a fresh
  // refetch is only kicked off when the previous one has settled.
  const liveTagsInFlightRef = useRef(false);
  const liveBookmarksInFlightRef = useRef(false);
  const livePreferencesInFlightRef = useRef(false);
  useEffect(() => {
    if (!session) return;
    const conn = connectLiveEvents({
      onEvents: (events: LiveEvent[]) => {
        let needsTags = false;
        let needsBookmarks = false;
        let needsPreferences = false;
        for (const ev of events) {
          if (ev.type !== "record" || !ev.collection) continue;
          if (ev.collection === "com.kipclip.tag") {
            needsTags = true;
          } else if (
            ev.collection === "community.lexicon.bookmarks.bookmark"
          ) {
            // Bookmark mutations affect tag counts in the sidebar; refresh
            // the bookmark list and the tag list together.
            needsBookmarks = true;
            needsTags = true;
          } else if (
            ev.collection === "com.kipclip.annotation" ||
            ev.collection === "app.bookmark.annotation"
          ) {
            needsBookmarks = true;
          } else if (ev.collection === "com.kipclip.preferences") {
            needsPreferences = true;
          }
        }
        if (needsTags && !liveTagsInFlightRef.current) {
          liveTagsInFlightRef.current = true;
          loadTags()
            .catch(() => {})
            .finally(() => {
              liveTagsInFlightRef.current = false;
            });
        }
        if (needsBookmarks && !liveBookmarksInFlightRef.current) {
          liveBookmarksInFlightRef.current = true;
          loadBookmarks()
            .catch(() => {})
            .finally(() => {
              liveBookmarksInFlightRef.current = false;
            });
        }
        if (needsPreferences && !livePreferencesInFlightRef.current) {
          livePreferencesInFlightRef.current = true;
          apiGet("/api/preferences")
            .then((r) => (r.ok ? r.json() : null))
            .then((p: UserPreferences | null) => {
              if (p) setPreferences(p);
            })
            .catch(() => {})
            .finally(() => {
              livePreferencesInFlightRef.current = false;
            });
        }
      },
    });
    return () => conn.close();
  }, [session?.did]);

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

  // Background re-enrichment for reading list bookmarks missing images.
  // Gated on !isSyncing so the enrich pass never competes with the
  // initial-load streaming flush for network bandwidth (without this,
  // requestIdleCallback fires during 500ms gaps between flushes since
  // the main thread looks idle to the browser, and enrich requests
  // start at ~900ms while streaming runs to ~2s).
  useEffect(() => {
    if (isSyncing) return;
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
              if (data.bookmark.image) {
                failedAttemptsRef.current.delete(bookmark.uri);
              } else {
                // Server returned 200 but found no image (no og:image,
                // unreachable URL, etc). Without bumping the retry counter
                // here, the filter would keep picking this bookmark forever
                // since `b.image` stays undefined — N+1 storm.
                const attempts = failedAttemptsRef.current.get(bookmark.uri) ||
                  0;
                failedAttemptsRef.current.set(bookmark.uri, attempts + 1);
              }
            } else {
              const attempts = failedAttemptsRef.current.get(bookmark.uri) || 0;
              failedAttemptsRef.current.set(bookmark.uri, attempts + 1);
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

    // Schedule the enrich batch only when the browser reports an idle
    // window. Each batch only fetches 3 bookmarks, but the cascade
    // (updateBookmark -> readingListBookmarks change -> effect re-runs)
    // means streaming the full reading list through enrichment generates
    // up to ~MAX_ENRICHMENT_RETRIES * <count> background HTTP requests
    // over a few seconds. Pushing it behind requestIdleCallback keeps
    // those requests off the main thread while the user is actively
    // scrolling, typing, or interacting.
    //
    // Fallback to setTimeout(1000) on browsers without requestIdleCallback
    // (Safari shipped it in 17.4 — older iOS versions still need it).
    const ric = (globalThis as any).requestIdleCallback;
    const cic = (globalThis as any).cancelIdleCallback;
    let handle: number | undefined;
    if (typeof ric === "function") {
      // timeout=5000 ensures the batch eventually fires even if the page
      // stays busy (e.g., long-running streaming flush). Without a cap
      // a busy tab could starve enrichment forever.
      handle = ric(enrichBatch, { timeout: 5000 });
      return () => {
        if (handle !== undefined && typeof cic === "function") {
          cic(handle);
        }
      };
    }
    handle = setTimeout(enrichBatch, 1000) as unknown as number;
    return () => {
      if (handle !== undefined) clearTimeout(handle);
    };
  }, [readingListBookmarks, isSyncing]);

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
    firstPageReady,
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
