import { useCallback, useEffect, useRef, useState } from "react";
import { useApp } from "../context/AppContext.tsx";
import { apiPatch } from "../utils/api.ts";
import { tagIncludes } from "../../shared/tag-utils.ts";
import type { EnrichedBookmark } from "../../shared/types.ts";

interface PendingAction {
  bookmark: EnrichedBookmark;
  originalTags: string[];
  newTags: string[];
  timerId: ReturnType<typeof setTimeout>;
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
  const { preferences, updateBookmark } = useApp();
  const pendingRef = useRef<PendingAction | null>(null);
  const [pendingState, setPendingState] = useState<
    { bookmark: EnrichedBookmark } | null
  >(null);

  // Keep a stable ref to updateBookmark so callbacks don't go stale
  const updateBookmarkRef = useRef(updateBookmark);
  updateBookmarkRef.current = updateBookmark;

  const flush = useCallback((action: PendingAction) => {
    persistAction(action, updateBookmarkRef.current);
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
    updateBookmarkRef.current({ ...bookmark, tags: newTags });

    const timerId = setTimeout(() => {
      const current = pendingRef.current;
      if (current && current.bookmark.uri === bookmark.uri) {
        pendingRef.current = null;
        setPendingState(null);
        flush(current);
      }
    }, 5000);

    const action: PendingAction = {
      bookmark,
      originalTags,
      newTags,
      timerId,
    };
    pendingRef.current = action;
    setPendingState({ bookmark });
  }, [preferences.readingListTag, flush]);

  const undo = useCallback(() => {
    const current = pendingRef.current;
    if (!current) return;
    clearTimeout(current.timerId);
    pendingRef.current = null;
    setPendingState(null);
    updateBookmarkRef.current({
      ...current.bookmark,
      tags: current.originalTags,
    });
  }, []);

  // Flush pending action on unmount only
  useEffect(() => {
    return () => {
      if (pendingRef.current) {
        clearTimeout(pendingRef.current.timerId);
        persistAction(pendingRef.current, updateBookmarkRef.current);
        pendingRef.current = null;
      }
    };
  }, []);

  return { markAsRead, undo, pending: pendingState };
}
