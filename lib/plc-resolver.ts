/**
 * PLC Directory resolver with Deno KV caching.
 * Caches DID document lookups to reduce PLC directory requests.
 */

import { getCached, invalidateCache } from "./kv-cache.ts";

const PLC_DIRECTORY = "https://plc.directory";
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

/**
 * Resolved DID document data.
 */
export interface ResolvedDid {
  did: string;
  pdsUrl: string;
  handle: string;
}

/**
 * Fetch DID document from PLC directory (no caching).
 */
async function fetchDidDoc(did: string): Promise<ResolvedDid | null> {
  const response = await fetch(`${PLC_DIRECTORY}/${did}`);

  if (!response.ok) {
    if (response.status === 404) {
      return null;
    }
    throw new Error(`PLC lookup failed: ${response.status}`);
  }

  const didDoc = await response.json();

  // Find PDS service endpoint
  const pdsService = didDoc.service?.find(
    (s: { id: string; serviceEndpoint?: string }) => s.id === "#atproto_pds",
  );

  if (!pdsService?.serviceEndpoint) {
    return null;
  }

  // Extract handle from alsoKnownAs
  let handle = did;
  if (didDoc.alsoKnownAs?.length > 0) {
    const atUri = didDoc.alsoKnownAs.find((aka: string) =>
      aka.startsWith("at://")
    );
    if (atUri) {
      handle = atUri.replace("at://", "");
    }
  }

  return {
    did,
    pdsUrl: pdsService.serviceEndpoint,
    handle,
  };
}

/**
 * Resolve a DID to its PDS URL and handle.
 * Results are cached for 1 hour. Cached nulls are automatically invalidated and re-fetched.
 */
export async function resolveDid(did: string): Promise<ResolvedDid | null> {
  if (!did.startsWith("did:")) {
    return null;
  }

  const cacheKey: Deno.KvKey = ["plc", did];

  try {
    let result: ResolvedDid | null = null;
    let cacheHit = false;

    try {
      result = await getCached<ResolvedDid | null>(
        cacheKey,
        CACHE_TTL_MS,
        () => fetchDidDoc(did),
      );
      cacheHit = true;
    } catch (cacheError) {
      console.error(`[PLC] Cache error for ${did}:`, cacheError);
      // If cache fails, fall back to direct fetch
      result = await fetchDidDoc(did);
    }

    // If we got a cached null, invalidate it and fetch fresh
    if (result === null && cacheHit) {
      await invalidateCache(cacheKey);
      const fresh = await fetchDidDoc(did);
      // Only cache successful results
      if (fresh !== null) {
        await getCached(cacheKey, CACHE_TTL_MS, () => Promise.resolve(fresh));
      }
      return fresh;
    }

    return result;
  } catch (error) {
    console.error(`[PLC] Failed to resolve DID ${did}:`, error);
    return null;
  }
}

/**
 * Resolve a DID with a custom fetcher (for testing).
 */
export async function resolveDidWithFetcher(
  did: string,
  fetcher: typeof fetch,
): Promise<ResolvedDid | null> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetcher;
  try {
    // Bypass cache for testing
    if (!did.startsWith("did:")) {
      return null;
    }

    const response = await fetcher(`${PLC_DIRECTORY}/${did}`);

    if (!response.ok) {
      if (response.status === 404) {
        return null;
      }
      throw new Error(`PLC lookup failed: ${response.status}`);
    }

    const didDoc = await response.json();

    const pdsService = didDoc.service?.find(
      (s: { id: string; serviceEndpoint?: string }) => s.id === "#atproto_pds",
    );

    if (!pdsService?.serviceEndpoint) {
      return null;
    }

    let handle = did;
    if (didDoc.alsoKnownAs?.length > 0) {
      const atUri = didDoc.alsoKnownAs.find((aka: string) =>
        aka.startsWith("at://")
      );
      if (atUri) {
        handle = atUri.replace("at://", "");
      }
    }

    return {
      did,
      pdsUrl: pdsService.serviceEndpoint,
      handle,
    };
  } catch (error) {
    console.error(`Failed to resolve DID ${did}:`, error);
    return null;
  } finally {
    globalThis.fetch = originalFetch;
  }
}
