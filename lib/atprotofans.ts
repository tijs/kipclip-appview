/**
 * atprotofans.com supporter detection.
 *
 * Checks whether a logged-in user has a `com.atprotofans.supporter` record
 * in their own PDS pointing at the kipclip creator DID. Result is cached
 * per-DID in memory for 24h. Failures are negative-cached for a short window
 * so a flaky PDS doesn't amplify load on every page view.
 */

/** Kipclip's creator DID on atprotofans.com. */
export const KIPCLIP_DID = "did:plc:3zzkrrjtsmo7nnwnvhex3auj";

/** External URL where users can become a supporter. */
export const ATPROTOFANS_SUPPORT_URL =
  `https://atprotofans.com/support/${KIPCLIP_DID}`;

// Production allowlist. Held as a private mutable set so the module can
// expose it as ReadonlySet (see AUTO_SUPPORTER_DIDS) — no external code
// can add to it. Tests use `_addTestAutoSupporter` instead.
const PROD_AUTO_SUPPORTERS = new Set<string>([
  KIPCLIP_DID, // kipclip.com
  "did:plc:aq7owa5y7ndc2hzjz37wy7ma", // tijs.org
]);

/**
 * DIDs that always receive supporter status without needing a PDS record.
 * Read-only for callers — only the module itself mutates the underlying set.
 */
export const AUTO_SUPPORTER_DIDS: ReadonlySet<string> = PROD_AUTO_SUPPORTERS;

// Test-only auto-supporters (populated from tests/test-setup.ts). Production
// calls ignore this set unless running under the same process as tests.
const TEST_AUTO_SUPPORTERS = new Set<string>();

/** Test-only: add a DID to the auto-supporter allowlist for the test process. */
export function _addTestAutoSupporter(did: string): void {
  TEST_AUTO_SUPPORTERS.add(did);
}

/** Test-only: drop all test-added auto-supporters. */
export function _resetTestAutoSupporters(): void {
  TEST_AUTO_SUPPORTERS.clear();
}

function isAutoSupporter(
  did: string,
  override?: ReadonlySet<string>,
): boolean {
  if (override?.has(did)) return true;
  return PROD_AUTO_SUPPORTERS.has(did) || TEST_AUTO_SUPPORTERS.has(did);
}

const SUPPORTER_COLLECTION = "com.atprotofans.supporter";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h for successful checks
const NEGATIVE_CACHE_TTL_MS = 60 * 1000; // 60s for PDS-error fallbacks
const REFRESH_COOLDOWN_MS = 30 * 1000; // bypassCache debounce window
const MAX_PAGES = 3; // cap listRecords pagination to avoid amplification
const MAX_PDS_RESPONSE_BYTES = 1 * 1024 * 1024; // 1 MiB per page

interface CacheEntry {
  value: boolean;
  expiresAt: number;
  /** Timestamp of the last uncached (live) PDS check for this DID. */
  lastLiveCheckAt: number;
}

const cache = new Map<string, CacheEntry>();

/** Test-only: reset cache between tests. */
export function _clearSupporterCache(): void {
  cache.clear();
}

export interface IsUserSupporterOptions {
  /**
   * When true, skip the cache and re-query the PDS — BUT only if the last
   * live check for this DID was more than REFRESH_COOLDOWN_MS ago. A more
   * recent live check wins (protects against status-endpoint hammering).
   */
  bypassCache?: boolean;
  /** Unit-test hook: override the auto-supporter allowlist. */
  autoSupporterDids?: ReadonlySet<string>;
}

/** Read up to `maxBytes` of a Response body as text, then JSON.parse. */
async function readJsonWithLimit(
  res: Response,
  maxBytes: number,
): Promise<unknown> {
  if (!res.body) return {};
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) {
        total += value.byteLength;
        if (total > maxBytes) {
          throw new Error(
            `PDS response exceeded ${maxBytes}-byte limit`,
          );
        }
        chunks.push(value);
      }
    }
  } finally {
    reader.releaseLock();
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(merged));
}

/**
 * Returns true when the given oauth session belongs to a kipclip supporter.
 *
 * Order of checks:
 *  1. Hardcoded allowlist (`AUTO_SUPPORTER_DIDS` + test additions) — instant
 *     true, no PDS call.
 *  2. In-memory cache (24h for success, 60s for failure) unless
 *     `bypassCache` is set AND the cooldown has elapsed.
 *  3. `com.atproto.repo.listRecords` on the user's PDS for the
 *     `com.atprotofans.supporter` collection; true if any record has
 *     `subject === KIPCLIP_DID`. Pagination capped at MAX_PAGES.
 *
 * PDS errors resolve to `false` and are negative-cached briefly so a flaky
 * PDS doesn't force a re-query on every request.
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
  if (isAutoSupporter(oauthSession.did, options.autoSupporterDids)) {
    return true;
  }

  const existing = cache.get(oauthSession.did);
  const now = Date.now();

  // Cooldown: even when bypassCache is set, honor the cache if the last
  // live check was recent. Protects /api/user/supporter-status from abuse.
  const inCooldown = existing &&
    now - existing.lastLiveCheckAt < REFRESH_COOLDOWN_MS;
  const shouldBypass = options.bypassCache && !inCooldown;

  if (!shouldBypass && existing && existing.expiresAt > now) {
    return existing.value;
  }

  let value = false;
  let failed = false;

  try {
    let cursor: string | undefined;
    let pages = 0;

    do {
      pages++;
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
        failed = true;
        break;
      }

      let data: any;
      try {
        data = await readJsonWithLimit(res, MAX_PDS_RESPONSE_BYTES);
      } catch (err) {
        console.warn(
          "Supporter check: PDS response too large or invalid:",
          err,
        );
        failed = true;
        break;
      }

      const records: Array<{ value?: { subject?: string } }> = data?.records ??
        [];

      if (records.some((r) => r.value?.subject === KIPCLIP_DID)) {
        value = true;
        break;
      }

      cursor = data?.cursor;
    } while (cursor && pages < MAX_PAGES);
  } catch (err) {
    console.warn("Supporter check failed:", err);
    failed = true;
  }

  cache.set(oauthSession.did, {
    value,
    expiresAt: now + (failed ? NEGATIVE_CACHE_TTL_MS : CACHE_TTL_MS),
    lastLiveCheckAt: now,
  });
  return value;
}
