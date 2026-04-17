/**
 * Unauthenticated helpers for the public share endpoints.
 *
 * These run on paths reachable by anyone on the internet, so every outbound
 * request needs URL hardening (SSRF), bounded work (DoS), and rate-limit
 * awareness.
 */

/** Typed error thrown by the public paginator so callers can branch on status. */
export class PdsListError extends Error {
  status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "PdsListError";
    this.status = status;
  }
}

/** `did:plc` and `did:web` are the only methods we accept. */
const DID_PATTERN = /^did:(plc|web):[a-zA-Z0-9._:%-]{1,256}$/;

/** Validate DID shape + method. Does not resolve. */
export function isValidDid(did: string): boolean {
  return DID_PATTERN.test(did);
}

/**
 * Throw if `pdsUrl` is unsafe to fetch from (wrong scheme, loopback/private
 * IP, or the "localhost" sentinel). Only literal-IP checks are performed;
 * DNS rebinding is not mitigated here and would require per-request lookup.
 */
export function assertSafePdsUrl(pdsUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(pdsUrl);
  } catch {
    throw new PdsListError(`Invalid PDS URL: ${pdsUrl}`, 400);
  }

  if (parsed.protocol !== "https:") {
    throw new PdsListError(`PDS must use https (got ${parsed.protocol})`, 400);
  }

  const host = parsed.hostname.toLowerCase();

  if (host === "localhost" || host.endsWith(".localhost")) {
    throw new PdsListError(`PDS host not allowed: ${host}`, 400);
  }

  // Strip brackets from IPv6 literal before parsing.
  const stripped = host.startsWith("[") && host.endsWith("]")
    ? host.slice(1, -1)
    : host;

  if (isPrivateIPv4(stripped) || isPrivateIPv6(stripped)) {
    throw new PdsListError(`PDS host not allowed: ${host}`, 400);
  }
}

function isPrivateIPv4(host: string): boolean {
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const [a, b] = [parseInt(m[1], 10), parseInt(m[2], 10)];
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 127) return true; // 127.0.0.0/8 (loopback)
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 (link-local, metadata)
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 0) return true; // 0.0.0.0/8
  if (a >= 224) return true; // multicast + reserved
  return false;
}

function isPrivateIPv6(host: string): boolean {
  // Only catches the common literal forms; full IPv6 parsing is out of scope.
  if (host === "::1" || host === "::" || host === "0:0:0:0:0:0:0:1") {
    return true;
  }
  if (host.startsWith("fc") || host.startsWith("fd")) return true; // unique local
  if (host.startsWith("fe80")) return true; // link-local
  if (host.startsWith("::ffff:")) {
    return isPrivateIPv4(host.slice(7));
  }
  return false;
}

/** Rate-limit info parsed from a PDS response. */
interface RateLimit {
  remaining: number;
  reset: number; // unix seconds
}

function parseRateLimit(res: Response): RateLimit | undefined {
  const remainingRaw = res.headers.get("ratelimit-remaining");
  if (remainingRaw === null) return undefined;
  const remaining = parseInt(remainingRaw, 10);
  if (Number.isNaN(remaining)) return undefined;
  const reset = parseInt(res.headers.get("ratelimit-reset") || "0", 10);
  return { remaining, reset };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Default safety limits for unauthenticated pagination. */
const DEFAULT_MAX_PAGES = 100; // 100 * 100 records = 10_000 records ceiling
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_TOTAL_DEADLINE_MS = 25_000;

export interface PaginateOptions {
  maxPages?: number;
  requestTimeoutMs?: number;
  totalDeadlineMs?: number;
}

/**
 * Paginate `com.atproto.repo.listRecords` against a PDS without auth.
 *
 * Safety contract:
 *   - Validates `pdsUrl` via {@link assertSafePdsUrl} before each request.
 *   - Caps total pages (default 100) and total wall time (default 25s).
 *   - Per-request timeout (default 10s) via AbortSignal.
 *   - Exits if the cursor fails to advance (hostile PDS returning a constant cursor).
 *   - On 429, sleeps for the `retry-after` header (capped) and retries once.
 *   - Throws {@link PdsListError} with HTTP status for non-OK responses.
 */
export async function paginateListRecordsPublic(
  pdsUrl: string,
  did: string,
  collection: string,
  opts: PaginateOptions = {},
): Promise<any[]> {
  assertSafePdsUrl(pdsUrl);

  const maxPages = opts.maxPages ?? DEFAULT_MAX_PAGES;
  const requestTimeoutMs = opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const totalDeadlineMs = opts.totalDeadlineMs ?? DEFAULT_TOTAL_DEADLINE_MS;

  const started = Date.now();
  const all: any[] = [];
  let cursor: string | undefined;
  let pages = 0;

  while (true) {
    if (pages >= maxPages) {
      console.warn(
        `[pds-public] page cap (${maxPages}) reached for ${did}/${collection}; returning partial results`,
      );
      break;
    }
    if (Date.now() - started > totalDeadlineMs) {
      console.warn(
        `[pds-public] deadline reached for ${did}/${collection}; returning partial results`,
      );
      break;
    }

    const params = new URLSearchParams({
      repo: did,
      collection,
      limit: "100",
    });
    if (cursor) params.set("cursor", cursor);

    const url = `${pdsUrl}/xrpc/com.atproto.repo.listRecords?${params}`;
    const res = await fetchWith429Retry(url, requestTimeoutMs);

    if (!res.ok) {
      throw new PdsListError(
        `listRecords failed for ${collection}`,
        res.status,
      );
    }

    const data = await res.json();
    const records = data.records || [];
    all.push(...records);

    const nextCursor: string | undefined = data.cursor || undefined;
    if (!nextCursor) break;

    // Hostile PDS returning the same cursor would spin forever.
    if (nextCursor === cursor) {
      console.warn(
        `[pds-public] non-advancing cursor from ${pdsUrl}; breaking`,
      );
      break;
    }

    // An empty page with a cursor is also a stall signal.
    if (records.length === 0) {
      console.warn(
        `[pds-public] empty page with cursor from ${pdsUrl}; breaking`,
      );
      break;
    }

    cursor = nextCursor;
    pages++;
  }

  return all;
}

async function fetchWith429Retry(
  url: string,
  requestTimeoutMs: number,
): Promise<Response> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await fetch(url, {
      redirect: "error",
      signal: AbortSignal.timeout(requestTimeoutMs),
    });

    if (res.status === 429) {
      const retryAfter = parseInt(res.headers.get("retry-after") || "1", 10);
      const waitMs = Math.min(Math.max(retryAfter, 1), 5) * 1000;
      await sleep(waitMs);
      continue;
    }

    // Proactively back off when we're near the limit.
    const rl = parseRateLimit(res);
    if (rl && rl.remaining < 5 && rl.reset > 0) {
      const now = Math.floor(Date.now() / 1000);
      const waitMs = Math.min(Math.max(rl.reset - now, 0), 3) * 1000;
      if (waitMs > 0) await sleep(waitMs);
    }

    return res;
  }

  throw new PdsListError(`listRecords rate-limited after retries`, 429);
}

/**
 * Run `fn` over `items` with at most `concurrency` tasks in flight.
 * Preserves input order in the results array.
 */
export async function mapLimit<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;

  async function worker(): Promise<void> {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  }

  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    () => worker(),
  );
  await Promise.all(workers);
  return results;
}
