/**
 * PLC Directory resolver.
 * Resolves DID documents from the PLC directory.
 */

const PLC_DIRECTORY = "https://plc.directory";

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
 */
export async function resolveDid(did: string): Promise<ResolvedDid | null> {
  if (!did.startsWith("did:")) {
    return null;
  }

  try {
    return await fetchDidDoc(did);
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
