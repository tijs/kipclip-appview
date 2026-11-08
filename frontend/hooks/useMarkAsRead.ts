import { useCallback, useEffect, useRef, useState } from "react";
import { useApp } from "../context/AppContext.tsx";
import { apiPatch } from "../utils/api.ts";
import { toast } from "sonner";
import { tagIncludes } from "../../shared/tag-utils.ts";
import type { EnrichedBookmark } from "../../shared/types.ts";

interface PendingAction {
  id: string;
  optimistic: EnrichedBookmark;
  bookmark: EnrichedBookmark;
  originalTags: string[];
  newTags: string[];
  timerId: ReturnType<typeof setTimeout>;
}

function ownsTags(
  current: EnrichedBookmark | undefined,
  action: PendingAction,
): current is EnrichedBookmark {
  return !!current && current.cid === action.optimistic.cid &&
    current.subject === action.optimistic.subject &&
    JSON.stringify(current.tags ?? []) === JSON.stringify(action.newTags);
}

export function computeNewTags(
  currentTags: string[],
  readingListTag: string,
): string[] {
  const filtered = currentTags.filter(
    (t) => t.toLowerCase() !== readingListTag.toLowerCase(),
  );
  if (!tagIncludes(filtered, "read")) {
    filtered.push("read");
  }
  return filtered;
}

async function persistAction(
  action: PendingAction,
  updateBookmark: (b: EnrichedBookmark) => void,
) {
  const rkey = action.bookmark.uri.split("/").pop();
  if (!rkey) return;

  try {
    const response = await apiPatch(`/api/bookmarks/${rkey}`, {
      tags: action.newTags,
    });
    if (response.ok) {
      const data = await response.json();
      if (data.bookmark) {
        updateBookmark(data.bookmark);
      }
    } else {
      updateBookmark({ ...action.bookmark, tags: action.originalTags });
    }
  } catch {
    updateBookmark({ ...action.bookmark, tags: action.originalTags });
  }
}

export function useMarkAsRead() {
  const { preferences, bookmarks, updateBookmark } = useApp();
  const bookmarksRef = useRef(bookmarks);
  bookmarksRef.current = bookmarks;
  const pendingRef = useRef<PendingAction | null>(null);
  const [pendingState, setPendingState] = useState<
    { id: string; bookmark: EnrichedBookmark } | null
  >(null);

  // Keep a stable ref to updateBookmark so callbacks don't go stale
  const updateBookmarkRef = useRef(updateBookmark);
  updateBookmarkRef.current = updateBookmark;

  const flush = useCallback((action: PendingAction) => {
    persistAction(action, (next) => {
      const current = bookmarksRef.current.find((b) =>
        b.uri === action.bookmark.uri
      );
      if (!ownsTags(current, action)) return;
      updateBookmarkRef.current({ ...current, cid: next.cid, tags: next.tags });
      if (next.tags === action.originalTags) {
        toast.error("Could not mark bookmark as read");
      }
    });
  }, []);

  const markAsRead = useCallback((bookmark: EnrichedBookmark) => {
    // Flush any existing pending action first
    if (pendingRef.current) {
      const prev = pendingRef.current;
      clearTimeout(prev.timerId);
      pendingRef.current = null;
      flush(prev);
    }

    const originalTags = bookmark.tags || [];
    const newTags = computeNewTags(originalTags, preferences.readingListTag);

    // Optimistic update — card disappears from reading list
    const optimistic = { ...bookmark, tags: newTags };
    updateBookmarkRef.current(optimistic);
    const id = crypto.randomUUID();

    const timerId = setTimeout(() => {
      const current = pendingRef.current;
      if (current && current.id === id) {
        pendingRef.current = null;
        setPendingState(null);
        flush(current);
      }
    }, 5000);

    const action: PendingAction = {
      id,
      optimistic,
      bookmark,
      originalTags,
      newTags,
      timerId,
    };
    pendingRef.current = action;
    setPendingState({ id, bookmark });
  }, [preferences.readingListTag, flush]);

  const undo = useCallback((id: string) => {
    const current = pendingRef.current;
    if (!current || current.id !== id) return;
    clearTimeout(current.timerId);
    pendingRef.current = null;
    setPendingState(null);
    const bookmark = bookmarksRef.current.find((b) =>
      b.uri === current.bookmark.uri
    );
    if (ownsTags(bookmark, current)) {
      updateBookmarkRef.current({ ...bookmark, tags: current.originalTags });
    }
  }, []);

  // Flush pending action on unmount only
  useEffect(() => {
    return () => {
      if (pendingRef.current) {
        clearTimeout(pendingRef.current.timerId);
        flush(pendingRef.current);
        pendingRef.current = null;
      }
    };
  }, []);

  return { markAsRead, undo, pending: pendingState };
}
