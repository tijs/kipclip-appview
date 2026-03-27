/**
 * First-page diff: compare server records against cached records
 * to find additions and edits without re-fetching everything.
 */

import type { EnrichedBookmark } from "../../shared/types.ts";

export interface DiffResult {
  /** Bookmarks with URIs not in the cache (new records). */
  additions: EnrichedBookmark[];
  /** Bookmarks with same URI but different CID (edited records). */
  updates: EnrichedBookmark[];
}

/**
 * Diff the server's first page of bookmarks against a cached URI→CID map.
 * Returns additions (new URIs) and updates (same URI, different CID).
 *
 * Records in cache but missing from the server page are ignored —
 * they may have been pushed off page 1 by newer records, not deleted.
 */
export function diffFirstPage(
  serverBookmarks: EnrichedBookmark[],
  cachedMap: Map<string, string>,
): DiffResult {
  const additions: EnrichedBookmark[] = [];
  const updates: EnrichedBookmark[] = [];

  for (const bookmark of serverBookmarks) {
    const cachedCid = cachedMap.get(bookmark.uri);
    if (cachedCid === undefined) {
      additions.push(bookmark);
    } else if (cachedCid !== bookmark.cid) {
      updates.push(bookmark);
    }
  }

  return { additions, updates };
}

/** Build a URI→CID map from an array of bookmarks. */
export function buildCidMap(
  bookmarks: EnrichedBookmark[],
): Map<string, string> {
  const map = new Map<string, string>();
  for (const b of bookmarks) {
    map.set(b.uri, b.cid);
  }
  return map;
}
