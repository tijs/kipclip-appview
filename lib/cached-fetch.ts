/**
 * Generic in-memory cache helper with TTL, request coalescing, and
 * fail-open behaviour. Designed for read-only public endpoints whose
 * upstream data changes slowly (e.g. social proof feeds: reviews,
 * supporters). Not suitable for per-user data — there is no eviction
 * beyond TTL, and the cache key is fixed per fetcher instance.
 *
 *   const fetcher = createCachedFetcher({
 *     ttlMs: 24 * 60 * 60 * 1000,
 *     fetch: () => fetchSomethingExpensive(),
 *   });
 *   const { data, stale } = await fetcher.get();
 *
 * `stale: true` means upstream is currently failing AND a cached value
 * was served. Empty data with `stale: true` means there is no cache to
 * fall back on.
 */

export interface CachedResult<T> {
  data: T;
  stale: boolean;
}

export interface CachedFetcher<T> {
  get(): Promise<CachedResult<T>>;
  /** Drop the cache and the in-flight refresh. Mainly useful for tests. */
  reset(): void;
}

interface CachedEntry<T> {
  data: T;
  fetchedAt: number;
}

export function createCachedFetcher<T>(
  options: {
    ttlMs: number;
    fetch: () => Promise<T>;
    /** Returned when upstream fails and there is no cache. */
    fallback: T;
    /** Tag for log messages. */
    label?: string;
  },
): CachedFetcher<T> {
  let cache: CachedEntry<T> | null = null;
  let inFlight: Promise<T> | null = null;

  return {
    async get(): Promise<CachedResult<T>> {
      const now = Date.now();
      if (cache && now - cache.fetchedAt < options.ttlMs) {
        return { data: cache.data, stale: false };
      }

      if (!inFlight) {
        inFlight = options.fetch()
          .then((data) => {
            cache = { data, fetchedAt: Date.now() };
            return data;
          })
          .finally(() => {
            inFlight = null;
          });
      }

      try {
        const data = await inFlight;
        return { data, stale: false };
      } catch (err) {
        const tag = options.label ? `[${options.label}]` : "[cached-fetch]";
        console.warn(`${tag} upstream fetch failed:`, (err as Error).message);
        if (cache) {
          return { data: cache.data, stale: true };
        }
        return { data: options.fallback, stale: true };
      }
    },
    reset(): void {
      cache = null;
      inFlight = null;
    },
  };
}

const DEFAULT_TIMEOUT_MS = 8000;

/** fetch() wrapper with an AbortController-driven timeout. */
export async function fetchWithTimeout(
  url: string,
  init?: RequestInit & { timeoutMs?: number },
): Promise<Response> {
  const controller = new AbortController();
  const ms = init?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}
