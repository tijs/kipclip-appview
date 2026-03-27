/**
 * IndexedDB cache layer for kipclip.
 * Caches bookmarks and tags per-user using the `idb` wrapper.
 * All methods silently no-op if IndexedDB is unavailable (e.g. private browsing).
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
    // Open at whatever version exists (no version = no upgrade = no blocked event).
    // Only triggers upgrade for brand-new databases.
    const opened = openDB<KipclipDB>(`kipclip-${did}`, undefined, {
      upgrade(database) {
        if (!database.objectStoreNames.contains("bookmarks")) {
          database.createObjectStore("bookmarks", { keyPath: "uri" });
        }
        if (!database.objectStoreNames.contains("tags")) {
          database.createObjectStore("tags", { keyPath: "uri" });
        }
      },
    });
    // 10s timeout — Safari can be slow opening large databases.
    const timeout = new Promise<null>((resolve) =>
      setTimeout(() => resolve(null), 10_000)
    );
    const start = Date.now();
    const result = await Promise.race([opened, timeout]);
    const elapsed = Date.now() - start;
    if (result) {
      db = result;
      if (elapsed > 1000) {
        console.warn(`IndexedDB opened in ${elapsed}ms`);
      }
    } else {
      console.warn(
        `IndexedDB open timed out after ${elapsed}ms, proceeding without cache`,
      );
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

/** Replace all bookmarks in cache (clear-and-replace for full refresh). */
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

/** Replace all tags in cache (clear-and-replace). */
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

/** Upsert bookmarks without clearing the store (for incremental sync). */
export async function upsertBookmarks(
  bookmarks: EnrichedBookmark[],
): Promise<void> {
  if (!db || bookmarks.length === 0) return;
  try {
    const tx = db.transaction("bookmarks", "readwrite");
    for (const b of bookmarks) {
      tx.store.put(b);
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

export async function clearAll(): Promise<void> {
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
