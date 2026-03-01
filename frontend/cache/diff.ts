/**
 * CID-based diffing for AT Protocol records.
 * Compares cached records against fresh records using URI + CID
 * to compute a minimal change set.
 */

interface HasUriAndCid {
  uri: string;
  cid: string;
}

export interface DiffResult<T> {
  added: T[];
  updated: T[];
  removed: T[];
  isEmpty: boolean;
}

/**
 * Compare cached records against fresh records using CIDs.
 * - URI not in cache → added
 * - URI in cache, CID differs → updated
 * - URI in cache, not in fresh → removed
 * - If all three lists are empty → isEmpty = true
 */
export function diffRecords<T extends HasUriAndCid>(
  cached: T[],
  fresh: T[],
): DiffResult<T> {
  const cachedMap = new Map<string, string>();
  for (const record of cached) {
    cachedMap.set(record.uri, record.cid);
  }

  const freshUris = new Set<string>();
  const added: T[] = [];
  const updated: T[] = [];

  for (const record of fresh) {
    freshUris.add(record.uri);
    const cachedCid = cachedMap.get(record.uri);
    if (cachedCid === undefined) {
      added.push(record);
    } else if (cachedCid !== record.cid) {
      updated.push(record);
    }
  }

  const removed = cached.filter((record) => !freshUris.has(record.uri));

  return {
    added,
    updated,
    removed,
    isEmpty: added.length === 0 && updated.length === 0 && removed.length === 0,
  };
}
