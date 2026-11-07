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
import { createTrailingTask } from "../../shared/async-work.ts";
import {
  preferencesFromResponse,
  refreshLivePreferences,
} from "../lib/preferences-response.ts";
import {
  loadRecentTags,
  nextRecentTags,
  saveRecentTags,
} from "../utils/recent-tags.ts";

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
async function responseError(
  response: Response,
  fallback: string,
): Promise<Error> {
  const body: unknown = await response.json().catch(() => null);
  if (body && typeof body === "object") {
    const message = (body as Record<string, unknown>).error;
    if (typeof message === "string") return new Error(message);
  }
  return new Error(fallback);
}

async function fetchFirstPage(): Promise<InitialDataResponse> {
  perf.start("initialDataFirstPage");
  const response = await apiGet("/api/initial-data");
  if (!response.ok) {
    throw await responseError(
      response,
      `Failed to load initial data (${response.status})`,
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
      throw await responseError(
        response,
        `Failed to load page ${pageNumber} (${response.status})`,
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
  /** True while the mirror backfill is still in progress (syncing=true in the API response). */
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

  // Recent tag actions
  recentTags: string[];
  trackTagUsage: (tagValue: string) => void;

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
  const [settings, setSettings] = useState<UserSettings>(DEFAULT_SETTINGS);
  const [preferences, setPreferences] = useState<UserPreferences>(
    DEFAULT_PREFERENCES,
  );
  const [readingListSelectedTags, setReadingListSelectedTags] = useState<
    Set<string>
  >(new Set());
  const [recentTags, setRecentTags] = useState<string[]>(() =>
    loadRecentTags()
  );

  function trackTagUsage(tagValue: string) {
    setRecentTags((prev) => {
      const next = nextRecentTags(prev, tagValue);
      saveRecentTags(next);
      return next;
    });
  }
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

  const sessionRef = useRef<SessionInfo | null>(null);
  const sessionEpoch = useRef(0);
  const dataRevision = useRef(0);
  const preferenceRevision = useRef(0);
  const preferenceSaves = useRef(0);
  const preferenceTail = useRef<Promise<void>>(Promise.resolve());
  const confirmedPreferences = useRef(DEFAULT_PREFERENCES);
  const fullQueue = useRef<(() => Promise<void>) | null>(null);
  const bookmarkQueue = useRef<(() => Promise<void>) | null>(null);
  const tagQueue = useRef<(() => Promise<void>) | null>(null);
  const preferenceQueue = useRef<(() => Promise<void>) | null>(null);
  const refreshInFlightRef = useRef(false);
  const bookmarkLoadActive = useRef(false);
  const tagLoadActive = useRef(false);
  const fullGeneration = useRef(0);

  function setSession(next: SessionInfo | null) {
    if (sessionRef.current?.did !== next?.did) {
      sessionEpoch.current++;
      dataRevision.current++;
      preferenceRevision.current++;
      fullQueue.current =
        bookmarkQueue.current =
        tagQueue.current =
        preferenceQueue.current =
          null;
      preferenceTail.current = Promise.resolve();
      preferenceSaves.current = 0;
      refreshInFlightRef.current =
        bookmarkLoadActive.current =
        tagLoadActive
          .current =
          false;
      setBookmarks([]);
      setTagsRaw([]);
      setSettings(DEFAULT_SETTINGS);
      setPreferences(DEFAULT_PREFERENCES);
      confirmedPreferences.current = DEFAULT_PREFERENCES;
      setIsSupporter(false);
      setMirrorSyncing(false);
      setIsSyncing(false);
      setFirstPageReady(false);
      setReadingListSelectedTags(new Set());
      if (sessionRef.current) setBookmarkSearchQuery("");
      setReadingListSearchQuery("");
      enrichingRef.current.clear();
      failedAttemptsRef.current.clear();
    }
    sessionRef.current = next;
    setSessionRaw(next);
  }
  useEffect(() => () => {
    sessionEpoch.current++;
    fullQueue.current =
      bookmarkQueue.current =
      tagQueue.current =
      preferenceQueue.current =
        null;
  }, []);

  function noteMutation() {
    dataRevision.current++;
    // Preserve newer local intent while an older snapshot is in flight.
    if (refreshInFlightRef.current) void runFullRefresh().catch(() => {});
    else {
      if (bookmarkLoadActive.current) void loadBookmarks().catch(() => {});
      if (tagLoadActive.current) void loadTags().catch(() => {});
    }
  }

  // Bookmark actions
  async function loadBookmarks() {
    if (refreshInFlightRef.current) return await runFullRefresh();
    if (!bookmarkQueue.current) {
      const owner = sessionEpoch.current;
      bookmarkQueue.current = createTrailingTask(async () => {
        if (owner !== sessionEpoch.current) return;
        const revision = dataRevision.current,
          generation = fullGeneration.current;
        bookmarkLoadActive.current = true;
        try {
          const response = await apiGet("/api/bookmarks");
          if (!response.ok) throw new Error("Failed to load bookmarks");
          const data = await response.json();
          if (
            owner === sessionEpoch.current &&
            revision === dataRevision.current &&
            generation === fullGeneration.current
          ) setBookmarks(data.bookmarks);
        } finally {
          if (owner === sessionEpoch.current) {
            bookmarkLoadActive.current = false;
          }
        }
      });
    }
    await bookmarkQueue.current();
  }

  function addBookmark(bookmark: EnrichedBookmark) {
    noteMutation();
    setBookmarks((prev) => [bookmark, ...prev]);
  }

  function updateBookmark(bookmark: EnrichedBookmark) {
    noteMutation();
    setBookmarks((prev) =>
      prev.map((b) => (b.uri === bookmark.uri ? bookmark : b))
    );
  }

  function deleteBookmark(uri: string) {
    noteMutation();
    setBookmarks((prev) => prev.filter((b) => b.uri !== uri));
  }

  // Tag actions
  async function loadTags() {
    if (refreshInFlightRef.current) return await runFullRefresh();
    if (!tagQueue.current) {
      const owner = sessionEpoch.current;
      tagQueue.current = createTrailingTask(async () => {
        if (owner !== sessionEpoch.current) return;
        const revision = dataRevision.current,
          generation = fullGeneration.current;
        tagLoadActive.current = true;
        try {
          const tagsList = await fetchTagsList();
          if (
            owner === sessionEpoch.current &&
            revision === dataRevision.current &&
            generation === fullGeneration.current
          ) setTags(tagsList);
        } finally {
          if (owner === sessionEpoch.current) tagLoadActive.current = false;
        }
      });
    }
    await tagQueue.current();
  }

  function addTag(tag: EnrichedTag) {
    noteMutation();
    setTags((prev) => [tag, ...prev]);
  }

  function updateTag(tag: EnrichedTag) {
    noteMutation();
    setTags((prev) => prev.map((t) => (t.uri === tag.uri ? tag : t)));
  }

  function deleteTag(uri: string) {
    noteMutation();
    setTags((prev) => prev.filter((t) => t.uri !== uri));
  }

  /** Apply settings/preferences/isSupporter from the first /api/initial-data response. */
  function applyServerMeta(data: InitialDataResponse) {
    if (data.settings) setSettings(data.settings);
    if (typeof data.isSupporter === "boolean") setIsSupporter(data.isSupporter);
    setMirrorSyncing(data.syncing ?? false);
    if (data.preferences && preferenceSaves.current === 0) {
      const localFormat = getDateFormat();
      const pdsFormat = data.preferences.dateFormat;
      if (localFormat !== "us" && pdsFormat === "us") {
        const value = { ...data.preferences, dateFormat: localFormat };
        confirmedPreferences.current = value;
        setPreferences(value);
        void updatePreferences({ dateFormat: localFormat }).catch(() =>
          toast.error("Date format was not saved")
        );
      } else {
        confirmedPreferences.current = data.preferences;
        setPreferences(data.preferences);
        setDateFormat(pdsFormat as any);
      }
    }
  }

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
    owner: number,
    onProgress?: (page: number) => void,
  ): Promise<{ bookmarkCount: number; pagesLoaded: number }> {
    const revision = dataRevision.current;
    const preferenceVersion = preferenceRevision.current;
    const current = () =>
      owner === sessionEpoch.current && revision === dataRevision.current;
    const tagsPromise = fetchTagsList().then((tagsList) => {
      if (current()) setTags(tagsList);
    });
    void tagsPromise.catch(() => {});

    const first = await fetchFirstPage();
    if (!current()) {
      await tagsPromise;
      return { bookmarkCount: 0, pagesLoaded: 0 };
    }
    applyServerMeta(
      preferenceVersion === preferenceRevision.current
        ? first
        : { ...first, preferences: undefined },
    );
    // Bookmarks arrive in PDS rkey-ascending order; filteredBookmarks re-sorts
    // by createdAt DESC so the final rendered list is always newest-first.
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
    let flushTimer: ReturnType<typeof setTimeout> | undefined;

    const flush = () => {
      if (flushTimer !== undefined) {
        clearTimeout(flushTimer);
        flushTimer = undefined;
      }
      if (!current() || pending.length === 0) return;
      const chunk = pending.splice(0, pending.length);
      pagesSinceFlush = 0;
      setBookmarks((prev) => prev.concat(chunk));
    };

    let pagesLoaded = 1;
    let totalAdded = 0;
    try {
      const result = await streamRemainingPages(
        first,
        (chunk) => {
          if (!current()) return;
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
  function runFullRefresh(): Promise<void> {
    if (!fullQueue.current) {
      const owner = sessionEpoch.current;
      fullQueue.current = createTrailingTask(async () => {
        if (owner !== sessionEpoch.current) return;
        fullGeneration.current++;
        refreshInFlightRef.current = true;
        setIsSyncing(true);
        try {
          await fetchAndApply(owner);
        } finally {
          if (owner === sessionEpoch.current) {
            refreshInFlightRef.current = false;
            setIsSyncing(false);
          }
        }
      });
    }
    return fullQueue.current();
  }

  async function loadInitialData() {
    const owner = sessionEpoch.current;
    perf.start("loadInitialData");
    try {
      await runFullRefresh();
    } finally {
      if (owner === sessionEpoch.current) {
        perf.end("loadInitialData");
        perf.flush({ visibility: "load" });
      }
    }
  }

  async function refreshData(toastId?: string | number) {
    const owner = sessionEpoch.current;
    try {
      await runFullRefresh();
      if (toastId !== undefined && owner === sessionEpoch.current) {
        toast.success("Bookmarks up to date", { id: toastId });
      }
    } catch (error) {
      if (toastId !== undefined) toast.error("Refresh failed", { id: toastId });
      throw error;
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
  async function loadPreferences() {
    if (refreshInFlightRef.current) return await runFullRefresh();
    if (!preferenceQueue.current) {
      const owner = sessionEpoch.current;
      preferenceQueue.current = createTrailingTask(async () => {
        if (owner !== sessionEpoch.current) return;
        const version = preferenceRevision.current;
        await refreshLivePreferences(
          () => apiGet("/api/preferences"),
          (value) => {
            if (
              owner === sessionEpoch.current &&
              version === preferenceRevision.current &&
              preferenceSaves.current === 0
            ) {
              confirmedPreferences.current = value;
              setPreferences(value);
              setDateFormat(value.dateFormat as any);
            }
          },
        );
      });
    }
    await preferenceQueue.current();
  }

  useEffect(() => {
    if (!session) return;
    const owner = sessionEpoch.current;
    let opened = false;
    const conn = connectLiveEvents({
      onStateChange: (state) => {
        if (state !== "open" || owner !== sessionEpoch.current) return;
        // First open belongs to bootstrap; subsequent opens must recover
        // events missed while disconnected or hidden.
        if (opened) void refreshData().catch(() => {});
        opened = true;
      },
      onEvents: (events: LiveEvent[]) => {
        if (owner !== sessionEpoch.current) return;
        let needsTags = false, needsBookmarks = false, needsPreferences = false;
        for (const ev of events) {
          if (ev.type !== "record" || !ev.collection) continue;
          if (ev.collection === "com.kipclip.tag") needsTags = true;
          else if (ev.collection === "community.lexicon.bookmarks.bookmark") {
            needsBookmarks = true;
            needsTags = true;
          } else if (
            ev.collection === "com.kipclip.annotation" ||
            ev.collection === "app.bookmark.annotation"
          ) needsBookmarks = true;
          else if (ev.collection === "com.kipclip.preferences") {
            needsPreferences = true;
          }
        }
        if (needsTags) void loadTags().catch(() => {});
        if (needsBookmarks) void loadBookmarks().catch(() => {});
        if (needsPreferences) void loadPreferences().catch(() => {});
      },
    });
    return () => conn.close();
  }, [session?.did]);

  // Supporter actions
  async function refreshSupporterStatus(): Promise<boolean> {
    const owner = sessionEpoch.current;
    const response = await apiGet("/api/user/supporter-status");
    if (!response.ok) {
      throw new Error("Failed to refresh supporter status");
    }
    const data: SupporterStatusResponse = await response.json();
    if (owner === sessionEpoch.current) setIsSupporter(data.isSupporter);
    return data.isSupporter;
  }

  // Settings actions
  async function updateSettings(updates: Partial<UserSettings>) {
    const owner = sessionEpoch.current;
    try {
      const response = await apiPatch("/api/settings", updates);
      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || "Failed to update settings");
      }
      const data = await response.json();
      if (data.settings && owner === sessionEpoch.current) {
        setSettings(data.settings);
      }
    } catch (err) {
      console.error("Failed to update settings:", err);
      throw err;
    }
  }

  // Preferences actions
  async function updatePreferences(updates: Partial<UserPreferences>) {
    const owner = sessionEpoch.current, version = ++preferenceRevision.current;
    preferenceSaves.current++;
    setPreferences((prev) => ({ ...prev, ...updates }));
    if (updates.dateFormat) setDateFormat(updates.dateFormat as any);
    const save = preferenceTail.current.catch(() => {}).then(async () => {
      if (owner !== sessionEpoch.current) return;
      const response = await apiPut("/api/preferences", updates);
      if (!response.ok) {
        throw new Error("Preferences were not saved. Please try again.");
      }
      const saved = preferencesFromResponse(await response.json());
      if (!saved) {
        throw new Error("Preferences were not saved. Please try again.");
      }
      if (owner === sessionEpoch.current) {
        confirmedPreferences.current = saved;
        if (version === preferenceRevision.current) {
          setPreferences(saved);
          setDateFormat(saved.dateFormat as any);
        }
      }
    });
    preferenceTail.current = save;
    try {
      await save;
    } catch (error) {
      if (
        owner === sessionEpoch.current && version === preferenceRevision.current
      ) {
        setPreferences(confirmedPreferences.current);
        setDateFormat(confirmedPreferences.current.dateFormat as any);
      }
      throw error;
    } finally {
      if (owner === sessionEpoch.current) preferenceSaves.current--;
    }
  }

  // Derive selectedTags from search query
  const parsedQuery = useMemo(
    () =>
      parseSearchQuery(
        bookmarkSearchQuery,
        tags.map((t) => t.value),
      ),
    [bookmarkSearchQuery, tags],
  );
  const selectedTags = useMemo(
    () => new Set(parsedQuery.tags),
    [parsedQuery.tags],
  );

  // Filter actions
  function toggleTag(tagValue: string) {
    trackTagUsage(tagValue);
    setBookmarkSearchQuery(
      toggleTagInQuery(
        bookmarkSearchQuery,
        tagValue,
        tags.map((t) => t.value),
      ),
    );
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
    // Sort newest-first by createdAt. PDS fallback returns records in rkey
    // order (ascending), which puts new TID-rkey bookmarks (3m...) after all
    // old hex-rkey imports (b89a...) — making recently-added bookmarks
    // invisible at position 1700+. Mirror reads return createdAt DESC already,
    // so this sort is a no-op for mirror users and a correctness fix for PDS.
    return [...result].sort((a, b) =>
      (b.createdAt ?? "").localeCompare(a.createdAt ?? "")
    );
  }, [bookmarks, tagIndex, selectedTags, parsedQuery.text]);

  const readingListBookmarks = useMemo(() => {
    const rlLower = preferences.readingListTag.toLowerCase();
    return bookmarks.filter((b) => {
      const tags = tagIndex.get(b.uri);
      return tags !== undefined && tags.has(rlLower);
    });
  }, [bookmarks, tagIndex, preferences.readingListTag]);

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

    return [...result].sort((a, b) =>
      (b.createdAt ?? "").localeCompare(a.createdAt ?? "")
    );
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

    const owner = sessionEpoch.current;
    let cancelled = false;
    const enrichBatch = async () => {
      const batch = bookmarksNeedingEnrichment.slice(0, 3);

      for (const bookmark of batch) {
        if (cancelled || owner !== sessionEpoch.current) break;
        if (enrichingRef.current.has(bookmark.uri)) continue;
        enrichingRef.current.add(bookmark.uri);

        try {
          const rkey = bookmark.uri.split("/").pop();
          if (!rkey) {
            enrichingRef.current.delete(bookmark.uri);
            continue;
          }

          const response = await apiPost(`/api/bookmarks/${rkey}/enrich`);
          if (owner !== sessionEpoch.current) continue;
          if (response.ok) {
            const data = await response.json();
            if (owner !== sessionEpoch.current) continue;
            if (data.bookmark) {
              noteMutation();
              // Apply metadata only to the exact source revision we enriched;
              // preserve current tags/notes and any intervening local edit.
              setBookmarks((current) =>
                current.map((b) =>
                  b.uri === bookmark.uri &&
                    b.cid === bookmark.cid && b.subject === bookmark.subject &&
                    b === bookmark
                    ? {
                      ...b,
                      title: data.bookmark.title,
                      description: data.bookmark.description,
                      image: data.bookmark.image,
                      favicon: data.bookmark.favicon,
                    }
                    : b
                )
              );
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
          if (owner !== sessionEpoch.current) continue;
          console.error("Failed to enrich bookmark:", err);
          const attempts = failedAttemptsRef.current.get(bookmark.uri) || 0;
          failedAttemptsRef.current.set(bookmark.uri, attempts + 1);
        } finally {
          if (owner === sessionEpoch.current) {
            enrichingRef.current.delete(bookmark.uri);
          }
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
        cancelled = true;
        if (handle !== undefined && typeof cic === "function") {
          cic(handle);
        }
      };
    }
    handle = setTimeout(enrichBatch, 1000) as unknown as number;
    return () => {
      cancelled = true;
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
    recentTags,
    trackTagUsage,
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

  // @ts-expect-error TS2875: Deno cannot resolve React's npm JSX runtime; esbuild handles it.
  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp() {
  const context = useContext(AppContext);
  if (!context) {
    throw new Error("useApp must be used within AppProvider");
  }
  return context;
}
