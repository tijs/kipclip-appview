/**
 * Tests for PLC resolver caching behavior.
 * Ensures cached null values are properly invalidated and re-fetched.
 */

import "./test-setup.ts";

import { assertEquals, assertNotEquals } from "@std/assert";
import { getCached, invalidateCache } from "../lib/kv-cache.ts";

// Disable resource sanitizer since KV is shared across tests
const testOpts = { sanitizeResources: false, sanitizeOps: false };

Deno.test(
  "getCached - returns cached value when not expired",
  testOpts,
  async () => {
    const key: Deno.KvKey = ["test", "cached-value"];
    const ttl = 60000; // 1 minute

    // Clean up first
    await invalidateCache(key);

    let fetchCount = 0;
    const fetcher = () => {
      fetchCount++;
      return Promise.resolve({ value: "test" });
    };

    // First call should fetch
    const result1 = await getCached(key, ttl, fetcher);
    assertEquals(result1, { value: "test" });
    assertEquals(fetchCount, 1);

    // Second call should return cached value
    const result2 = await getCached(key, ttl, fetcher);
    assertEquals(result2, { value: "test" });
    assertEquals(fetchCount, 1); // Should NOT have fetched again

    // Clean up
    await invalidateCache(key);
  },
);

Deno.test(
  "getCached - caches null values (the problem scenario)",
  testOpts,
  async () => {
    const key: Deno.KvKey = ["test", "null-value"];
    const ttl = 60000;

    // Clean up first
    await invalidateCache(key);

    let fetchCount = 0;
    const fetcher = () => {
      fetchCount++;
      return Promise.resolve(null);
    };

    // First call - fetches and caches null
    const result1 = await getCached(key, ttl, fetcher);
    assertEquals(result1, null);
    assertEquals(fetchCount, 1);

    // Second call - returns cached null (this is the problematic behavior we need to handle)
    const result2 = await getCached(key, ttl, fetcher);
    assertEquals(result2, null);
    assertEquals(fetchCount, 1); // Didn't fetch again because null was cached

    // Clean up
    await invalidateCache(key);
  },
);

Deno.test("invalidateCache - removes cached value", testOpts, async () => {
  const key: Deno.KvKey = ["test", "invalidate"];
  const ttl = 60000;

  // Clean up first
  await invalidateCache(key);

  let fetchCount = 0;
  const fetcher = () => {
    fetchCount++;
    return Promise.resolve({ count: fetchCount });
  };

  // First call
  const result1 = await getCached(key, ttl, fetcher);
  assertEquals(result1, { count: 1 });

  // Invalidate
  await invalidateCache(key);

  // Next call should fetch fresh
  const result2 = await getCached(key, ttl, fetcher);
  assertEquals(result2, { count: 2 });

  // Clean up
  await invalidateCache(key);
});

Deno.test(
  "PLC resolver - recovers from cached null by re-fetching",
  testOpts,
  async () => {
    // This test simulates the exact bug we had:
    // 1. First request fails (returns null) and gets cached
    // 2. Second request should detect cached null, invalidate, and fetch fresh

    const key: Deno.KvKey = ["test", "plc-recovery"];
    const ttl = 60000;

    // Clean up first
    await invalidateCache(key);

    // Simulate the resolver logic
    type ResolvedDid = { did: string; pdsUrl: string; handle: string } | null;

    let callCount = 0;
    const fetchDidDoc = (): Promise<ResolvedDid> => {
      callCount++;
      // First call fails, subsequent calls succeed
      if (callCount === 1) {
        return Promise.resolve(null); // Simulates failed PLC lookup
      }
      return Promise.resolve({
        did: "did:plc:test123",
        pdsUrl: "https://test.pds.example",
        handle: "test.handle",
      });
    };

    // Implementation of the fix we applied
    const resolveDid = async (): Promise<ResolvedDid> => {
      let result: ResolvedDid = null;
      let cacheHit = false;

      try {
        result = await getCached<ResolvedDid>(key, ttl, fetchDidDoc);
        cacheHit = true;
      } catch {
        result = await fetchDidDoc();
      }

      // If we got a cached null, invalidate and re-fetch
      if (result === null && cacheHit) {
        await invalidateCache(key);
        const fresh = await fetchDidDoc();
        if (fresh !== null) {
          // Re-cache the good result
          await getCached(key, ttl, () => Promise.resolve(fresh));
        }
        return fresh;
      }

      return result;
    };

    // First call: getCached calls fetchDidDoc which returns null, caches it
    const result1 = await resolveDid();
    // But our fix detects cached null and re-fetches, getting good result
    assertNotEquals(result1, null);
    assertEquals(result1?.handle, "test.handle");

    // Verify fetch was called twice (once for initial cache miss, once for recovery)
    assertEquals(callCount, 2);

    // Third call should use cached good value
    const result2 = await resolveDid();
    assertEquals(result2?.handle, "test.handle");
    assertEquals(callCount, 2); // No additional fetch

    // Clean up
    await invalidateCache(key);
  },
);

Deno.test(
  "PLC resolver - does not infinitely loop on persistent null",
  testOpts,
  async () => {
    // If the DID truly doesn't exist, we should return null without looping
    const key: Deno.KvKey = ["test", "plc-truly-null"];
    const ttl = 60000;

    // Clean up first
    await invalidateCache(key);

    type ResolvedDid = { did: string; pdsUrl: string; handle: string } | null;

    let callCount = 0;
    const fetchDidDoc = (): Promise<ResolvedDid> => {
      callCount++;
      return Promise.resolve(null); // Always returns null (DID doesn't exist)
    };

    const resolveDid = async (): Promise<ResolvedDid> => {
      let result: ResolvedDid = null;
      let cacheHit = false;

      try {
        result = await getCached<ResolvedDid>(key, ttl, fetchDidDoc);
        cacheHit = true;
      } catch {
        result = await fetchDidDoc();
      }

      if (result === null && cacheHit) {
        await invalidateCache(key);
        const fresh = await fetchDidDoc();
        if (fresh !== null) {
          await getCached(key, ttl, () => Promise.resolve(fresh));
        }
        return fresh;
      }

      return result;
    };

    // Call should return null after trying twice
    const result = await resolveDid();
    assertEquals(result, null);

    // Should have called fetch exactly twice (initial + one retry)
    assertEquals(callCount, 2);

    // Clean up
    await invalidateCache(key);
  },
);
