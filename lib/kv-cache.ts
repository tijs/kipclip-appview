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
  const keyStr = JSON.stringify(key);
  console.log(
    `[KV] getCached ${keyStr}: cached.value=${!!cached
      .value}, expiresAt=${cached.value?.expiresAt}, now=${Date.now()}`,
  );

  if (cached.value && cached.value.expiresAt > Date.now()) {
    console.log(
      `[KV] getCached ${keyStr}: returning cached value: ${
        JSON.stringify(cached.value.value)?.slice(0, 100)
      }`,
    );
    return cached.value.value;
  }

  // Fetch fresh value
  console.log(`[KV] getCached ${keyStr}: cache miss or expired, fetching...`);
  const value = await fetcher();
  console.log(
    `[KV] getCached ${keyStr}: fetched value: ${
      JSON.stringify(value)?.slice(0, 100)
    }`,
  );

  // Store in cache with expiration
  const entry: CacheEntry<T> = {
    value,
    expiresAt: Date.now() + ttlMs,
  };

  await db.set(key, entry);
  console.log(`[KV] getCached ${keyStr}: stored in cache with TTL ${ttlMs}ms`);

  return value;
}

/**
 * Invalidate a cached value.
 */
export async function invalidateCache(key: Deno.KvKey): Promise<void> {
  const db = await getKv();
  console.log(`[KV] invalidateCache ${JSON.stringify(key)}`);
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
