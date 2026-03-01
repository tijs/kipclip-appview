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
  meta: {
    key: string;
    value: { key: string; value: string };
  };
}

let db: IDBPDatabase<KipclipDB> | null = null;
let dbFailed = false;

export async function openCacheDb(did: string): Promise<void> {
  if (dbFailed) return;
  perf.start("dbOpen");
  try {
    db = await openDB<KipclipDB>(`kipclip-${did}`, 1, {
      upgrade(database) {
        database.createObjectStore("bookmarks", { keyPath: "uri" });
        database.createObjectStore("tags", { keyPath: "uri" });
        database.createObjectStore("meta", { keyPath: "key" });
      },
    });
  } catch {
    dbFailed = true;
  }
  perf.end("dbOpen");
}

export async function getCachedBookmarks(): Promise<EnrichedBookmark[] | null> {
  if (!db) return null;
  try {
    const all = await db.getAll("bookmarks");
    return all.length > 0 ? all : null;
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

export async function getSyncMeta(key: string): Promise<string | null> {
  if (!db) return null;
  try {
    const entry = await db.get("meta", key);
    return entry?.value ?? null;
  } catch {
    return null;
  }
}

export async function setSyncMeta(key: string, value: string): Promise<void> {
  if (!db) return;
  try {
    await db.put("meta", { key, value });
  } catch {
    // silently ignore
  }
}

export async function clearAll(): Promise<void> {
  if (!db) return;
  try {
    const tx = db.transaction(["bookmarks", "tags", "meta"], "readwrite");
    tx.objectStore("bookmarks").clear();
    tx.objectStore("tags").clear();
    tx.objectStore("meta").clear();
    await tx.done;
  } catch {
    // silently ignore
  }
}
