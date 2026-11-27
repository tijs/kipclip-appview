import { assertEquals } from "@std/assert";
import { getMentions } from "../lib/mentions.ts";

Deno.test("mentions merges text and preview links, deduplicates, batches and selects newest", async () => {
  const originalFetch = globalThis.fetch;
  const posts = Array.from({ length: 30 }, (_, i) => ({
    uri: `at://did:plc:reader/app.bsky.feed.post/post-${i}`,
    cid: `cid-${i}`,
    author: { did: "did:plc:reader", handle: "reader.example" },
    record: { text: "A mention with enough text to pass the minimum length." },
    indexedAt: new Date(Date.UTC(2026, 0, i + 1)).toISOString(),
    likeCount: 100 - i,
  }));
  const paths: string[] = [];
  const batches: string[][] = [];
  globalThis.fetch = ((input) => {
    const url = new URL(String(input));
    if (url.hostname === "constellation.microcosm.blue") {
      const path = url.searchParams.get("path")!;
      paths.push(path);
      const indices = path.startsWith(".facets")
        ? Array.from({ length: 25 }, (_, i) => i)
        : path === ".embed.external.uri"
        ? [0, 25, 26, 27, 28]
        : [28, 29];
      return Promise.resolve(Response.json({
        linking_records: indices.map((i) => ({
          did: "did:plc:reader",
          collection: "app.bsky.feed.post",
          rkey: `post-${i}`,
        })),
      }));
    }
    const uris = url.searchParams.getAll("uris");
    batches.push(uris);
    return Promise.resolve(Response.json({
      posts: posts.filter((post) => uris.includes(post.uri)),
    }));
  }) as typeof fetch;
  try {
    const result = await getMentions();
    assertEquals(result.stale, false);
    assertEquals(
      paths.sort(),
      [
        ".facets[].features[app.bsky.richtext.facet#link].uri",
        ".embed.external.uri",
        ".embed.media.external.uri",
      ].sort(),
    );
    assertEquals(batches.map((batch) => batch.length), [25, 5]);
    assertEquals(new Set(batches.flat()).size, 30);
    assertEquals(
      result.data.map((post) => post.uri),
      posts.slice(-6).reverse().map((post) => post.uri),
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
