/**
 * DID resolver.
 *
 * `did:plc:*` resolves via the PLC directory.
 * `did:web:<domain>[:<path>]` resolves via the canonical did.json on that
 * host (per the did:web spec).
 */

const PLC_DIRECTORY = "https://plc.directory";

/**
 * Build the well-known URL for a did:web identifier. Per the did:web
 * spec: `did:web:example.com` → `https://example.com/.well-known/did.json`;
 * `did:web:example.com:user:alice` →
 * `https://example.com/user/alice/did.json`. Path segments may be percent-
 * encoded.
 */
function didWebUrl(did: string): string {
  const ident = did.slice("did:web:".length);
  const parts = ident.split(":").map((p) => decodeURIComponent(p));
  const host = parts[0];
  const path = parts.length === 1
    ? "/.well-known/did.json"
    : "/" + parts.slice(1).join("/") + "/did.json";
  return `https://${host}${path}`;
}

interface DidDoc {
  alsoKnownAs?: string[];
  service?: Array<{ id?: string; type?: string; serviceEndpoint?: string }>;
}

function extractFromDoc(did: string, doc: DidDoc): ResolvedDid | null {
  const pds = doc.service?.find(
    (s) => s.id === "#atproto_pds" || s.type === "AtprotoPersonalDataServer",
  );
  if (!pds?.serviceEndpoint) return null;

  let handle = did;
  const atUri = doc.alsoKnownAs?.find((aka) => aka.startsWith("at://"));
  if (atUri) handle = atUri.replace("at://", "");

  return { did, pdsUrl: pds.serviceEndpoint, handle };
}

/**
 * Resolved DID document data.
 */
export interface ResolvedDid {
  did: string;
  pdsUrl: string;
  handle: string;
}

/** Fetch the DID document from the source canonical for this DID method. */
async function fetchDidDoc(did: string): Promise<ResolvedDid | null> {
  const url = did.startsWith("did:web:")
    ? didWebUrl(did)
    : `${PLC_DIRECTORY}/${did}`;

  const response = await fetch(url);

  if (!response.ok) {
    if (response.status === 404) return null;
    throw new Error(`DID resolve failed: ${response.status}`);
  }

  const didDoc = (await response.json()) as DidDoc;
  return extractFromDoc(did, didDoc);
}

/**
 * Resolve a DID to its PDS URL and handle. Supports did:plc and did:web.
 */
export async function resolveDid(did: string): Promise<ResolvedDid | null> {
  if (!did.startsWith("did:plc:") && !did.startsWith("did:web:")) {
    return null;
  }

  try {
    return await fetchDidDoc(did);
  } catch (error) {
    console.error(`[resolveDid] Failed to resolve ${did}:`, error);
    return null;
  }
}

/**
 * Resolve a DID with a custom fetcher (for testing). Supports did:plc and
 * did:web; routes to the canonical source for each method.
 */
export async function resolveDidWithFetcher(
  did: string,
  fetcher: typeof fetch,
): Promise<ResolvedDid | null> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetcher;
  try {
    if (!did.startsWith("did:plc:") && !did.startsWith("did:web:")) {
      return null;
    }

    const url = did.startsWith("did:web:")
      ? didWebUrl(did)
      : `${PLC_DIRECTORY}/${did}`;
    const response = await fetcher(url);

    if (!response.ok) {
      if (response.status === 404) {
        return null;
      }
      throw new Error(`DID resolve failed: ${response.status}`);
    }

    const didDoc = await response.json();

    const pdsService = didDoc.service?.find(
      (s: { id?: string; type?: string; serviceEndpoint?: string }) =>
        s.id === "#atproto_pds" ||
        s.type === "AtprotoPersonalDataServer",
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
