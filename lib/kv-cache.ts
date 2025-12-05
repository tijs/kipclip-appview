/**
 * Deno KV caching utilities.
 * Provides a simple cache-aside pattern for expensive operations.
 */

let kv: Deno.Kv | null = null;

/**
 * Get or initialize the Deno KV instance.
 * Uses local file storage in development, Deno Deploy KV in production.
 */
async function getKv(): Promise<Deno.Kv> {
  if (!kv) {
    kv = await Deno.openKv();
  }
  return kv;
}

/**
 * Cache entry with expiration metadata.
 */
interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

/**
 * Get a cached value, or fetch and cache it if not present or expired.
 *
 * @param key - KV key tuple (e.g., ["metadata", urlHash])
 * @param ttlMs - Time-to-live in milliseconds
 * @param fetcher - Async function to fetch the value if not cached
 * @returns The cached or freshly fetched value
 */
export async function getCached<T>(
  key: Deno.KvKey,
  ttlMs: number,
  fetcher: () => Promise<T>,
): Promise<T> {
  const db = await getKv();

  // Try to get from cache
  const cached = await db.get<CacheEntry<T>>(key);

  if (cached.value && cached.value.expiresAt > Date.now()) {
    return cached.value.value;
  }

  // Fetch fresh value
  const value = await fetcher();

  // Store in cache with expiration
  const entry: CacheEntry<T> = {
    value,
    expiresAt: Date.now() + ttlMs,
  };

  await db.set(key, entry);

  return value;
}

/**
 * Invalidate a cached value.
 */
export async function invalidateCache(key: Deno.KvKey): Promise<void> {
  const db = await getKv();
  await db.delete(key);
}

/**
 * Close the KV connection (useful for tests).
 */
export function closeKv(): void {
  if (kv) {
    kv.close();
    kv = null;
  }
}
