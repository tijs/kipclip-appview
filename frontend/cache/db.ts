/**
 * IndexedDB cache layer for kipclip.
 * Caches bookmarks and tags per-user using the `idb` wrapper.
 * All methods silently no-op if IndexedDB is unavailable (e.g. private browsing).
 *
 * Sync metadata (hashes, timestamps) uses localStorage instead of IndexedDB
 * to avoid version migration issues in Safari.
 */

import { type DBSchema, type IDBPDatabase, openDB } from "idb";
import type { EnrichedBookmark, EnrichedTag } from "../../shared/types.ts";
import { perf } from "../perf.ts";

interface KipclipDB extends DBSchema {
  bookmarks: {
    key: string;
    value: EnrichedBookmark;
  };
  tags: {
    key: string;
    value: EnrichedTag;
  };
}

let db: IDBPDatabase<KipclipDB> | null = null;
let dbFailed = false;

export async function openCacheDb(did: string): Promise<void> {
  if (dbFailed) return;
  perf.start("dbOpen");
  try {
    // Race against a timeout — Safari can hang on indexedDB.open()
    const opened = openDB<KipclipDB>(`kipclip-${did}`, 1, {
      upgrade(database) {
        if (!database.objectStoreNames.contains("bookmarks")) {
          database.createObjectStore("bookmarks", { keyPath: "uri" });
        }
        if (!database.objectStoreNames.contains("tags")) {
          database.createObjectStore("tags", { keyPath: "uri" });
        }
      },
      blocked() {
        console.warn("IndexedDB blocked by another tab");
      },
    });
    const timeout = new Promise<null>((resolve) =>
      setTimeout(() => resolve(null), 3000)
    );
    const result = await Promise.race([opened, timeout]);
    if (result) {
      db = result;
    } else {
      console.warn("IndexedDB open timed out, proceeding without cache");
      dbFailed = true;
    }
  } catch {
    dbFailed = true;
  }
  perf.end("dbOpen");
}

export async function getCachedBookmarks(): Promise<EnrichedBookmark[] | null> {
  if (!db) return null;
  try {
    const all = await db.getAll("bookmarks");
    if (all.length === 0) return null;
    // IndexedDB returns records in key order (uri), not insertion order.
    // Re-sort by createdAt descending so newest bookmarks appear first.
    all.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return all;
  } catch {
    return null;
  }
}

export async function getCachedTags(): Promise<EnrichedTag[] | null> {
  if (!db) return null;
  try {
    const all = await db.getAll("tags");
    return all.length > 0 ? all : null;
  } catch {
    return null;
  }
}

export async function putBookmarks(
  bookmarks: EnrichedBookmark[],
): Promise<void> {
  if (!db) return;
  try {
    const tx = db.transaction("bookmarks", "readwrite");
    await tx.store.clear();
    for (const b of bookmarks) {
      tx.store.put(b);
    }
    await tx.done;
  } catch {
    // silently ignore
  }
}

export async function putTags(tags: EnrichedTag[]): Promise<void> {
  if (!db) return;
  try {
    const tx = db.transaction("tags", "readwrite");
    await tx.store.clear();
    for (const t of tags) {
      tx.store.put(t);
    }
    await tx.done;
  } catch {
    // silently ignore
  }
}

export async function putBookmark(bookmark: EnrichedBookmark): Promise<void> {
  if (!db) return;
  try {
    await db.put("bookmarks", bookmark);
  } catch {
    // silently ignore
  }
}

export async function deleteBookmarkFromCache(uri: string): Promise<void> {
  if (!db) return;
  try {
    await db.delete("bookmarks", uri);
  } catch {
    // silently ignore
  }
}

export async function putTag(tag: EnrichedTag): Promise<void> {
  if (!db) return;
  try {
    await db.put("tags", tag);
  } catch {
    // silently ignore
  }
}

export async function deleteTagFromCache(uri: string): Promise<void> {
  if (!db) return;
  try {
    await db.delete("tags", uri);
  } catch {
    // silently ignore
  }
}

/** Sync metadata stored in localStorage (avoids IndexedDB version migrations). */
export function getSyncMeta(key: string): Promise<string | null> {
  try {
    return Promise.resolve(localStorage.getItem(`kipclip-sync-${key}`));
  } catch {
    return Promise.resolve(null);
  }
}

export function setSyncMeta(key: string, value: string): Promise<void> {
  try {
    localStorage.setItem(`kipclip-sync-${key}`, value);
  } catch {
    // silently ignore
  }
  return Promise.resolve();
}

export async function clearAll(): Promise<void> {
  try {
    // Clear localStorage sync metadata
    const keysToRemove: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith("kipclip-sync-")) keysToRemove.push(key);
    }
    keysToRemove.forEach((k) => localStorage.removeItem(k));
  } catch {
    // silently ignore
  }

  if (!db) return;
  try {
    const tx = db.transaction(["bookmarks", "tags"], "readwrite");
    tx.objectStore("bookmarks").clear();
    tx.objectStore("tags").clear();
    await tx.done;
  } catch {
    // silently ignore
  }
}
