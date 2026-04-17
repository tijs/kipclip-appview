/**
 * atprotofans.com supporter detection.
 *
 * Checks whether a logged-in user has a `com.atprotofans.supporter` record
 * in their own PDS pointing at the kipclip creator DID. Result is cached
 * per-DID in memory for 24h. Failures resolve to `false` and are not
 * cached, so transient PDS errors don't lock users out.
 */

/** Kipclip's creator DID on atprotofans.com. */
export const KIPCLIP_DID = "did:plc:3zzkrrjtsmo7nnwnvhex3auj";

/**
 * DIDs that always receive supporter status without needing a PDS record.
 * Matched by DID (not handle) so a handle rename can't silently strip access.
 */
export const AUTO_SUPPORTER_DIDS = new Set<string>([
  KIPCLIP_DID, // kipclip.com
  "did:plc:aq7owa5y7ndc2hzjz37wy7ma", // tijs.org
]);

const SUPPORTER_COLLECTION = "com.atprotofans.supporter";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h

interface CacheEntry {
  value: boolean;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

/** Exported for tests. */
export function _clearSupporterCache(): void {
  cache.clear();
}

export interface IsUserSupporterOptions {
  /** When true, skip the cache, re-query the PDS, and update the cache. */
  bypassCache?: boolean;
}

/**
 * Returns true when the given oauth session belongs to a kipclip supporter.
 *
 * Order of checks:
 *  1. Hardcoded allowlist (`AUTO_SUPPORTER_DIDS`) — instant true.
 *  2. In-memory cache (24h) unless `bypassCache` is set.
 *  3. `com.atproto.repo.listRecords` on the user's PDS for the
 *     `com.atprotofans.supporter` collection; true if any record has
 *     `subject === KIPCLIP_DID`.
 *
 * PDS errors resolve to `false` and are NOT cached.
 */
export async function isUserSupporter(
  oauthSession: {
    did: string;
    pdsUrl: string;
    makeRequest: (
      method: string,
      url: string,
      init?: { headers?: Record<string, string>; body?: string },
    ) => Promise<Response>;
  },
  options: IsUserSupporterOptions = {},
): Promise<boolean> {
  if (AUTO_SUPPORTER_DIDS.has(oauthSession.did)) {
    return true;
  }

  if (!options.bypassCache) {
    const entry = cache.get(oauthSession.did);
    if (entry && entry.expiresAt > Date.now()) {
      return entry.value;
    }
  }

  try {
    let cursor: string | undefined;
    let isSupporter = false;

    do {
      const params = new URLSearchParams({
        repo: oauthSession.did,
        collection: SUPPORTER_COLLECTION,
        limit: "100",
      });
      if (cursor) params.set("cursor", cursor);

      const res = await oauthSession.makeRequest(
        "GET",
        `${oauthSession.pdsUrl}/xrpc/com.atproto.repo.listRecords?${params}`,
      );
      if (!res.ok) {
        console.warn(
          `Supporter check: PDS responded ${res.status} for ${oauthSession.did}`,
        );
        return false;
      }

      const data = await res.json();
      const records: Array<{ value?: { subject?: string } }> = data.records ??
        [];

      if (records.some((r) => r.value?.subject === KIPCLIP_DID)) {
        isSupporter = true;
        break;
      }

      cursor = data.cursor;
    } while (cursor);

    cache.set(oauthSession.did, {
      value: isSupporter,
      expiresAt: Date.now() + CACHE_TTL_MS,
    });
    return isSupporter;
  } catch (err) {
    console.warn("Supporter check failed:", err);
    return false;
  }
}
