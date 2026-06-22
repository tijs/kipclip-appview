import { assertEquals } from "@std/assert";
import { normalizeUrlForMatching } from "../shared/url-utils.ts";

Deno.test("normalizeUrlForMatching - returns protocol, host, and path", () => {
  assertEquals(
    normalizeUrlForMatching("https://example.com/page"),
    "https://example.com/page",
  );
});

Deno.test("normalizeUrlForMatching - strips UTM tracking params", () => {
  assertEquals(
    normalizeUrlForMatching(
      "https://example.com/page?utm_source=google&utm_medium=cpc",
    ),
    "https://example.com/page",
  );
});

Deno.test("normalizeUrlForMatching - strips UTM but keeps meaningful params", () => {
  assertEquals(
    normalizeUrlForMatching(
      "https://example.com/page?utm_source=google&ref=twitter",
    ),
    "https://example.com/page?ref=twitter",
  );
});

Deno.test("normalizeUrlForMatching - preserves meaningful query params", () => {
  assertEquals(
    normalizeUrlForMatching("https://example.com/article?page=2"),
    "https://example.com/article?page=2",
  );
});

Deno.test("normalizeUrlForMatching - sorts query params for stable matching", () => {
  assertEquals(
    normalizeUrlForMatching("https://example.com/page?b=2&a=1"),
    normalizeUrlForMatching("https://example.com/page?a=1&b=2"),
  );
});

Deno.test("normalizeUrlForMatching - strips uppercase/mixed-case UTM params", () => {
  assertEquals(
    normalizeUrlForMatching(
      "https://example.com/page?UTM_SOURCE=google&Utm_Medium=cpc",
    ),
    "https://example.com/page",
  );
  // ...while keeping a non-UTM param that happens to share the prefix base
  assertEquals(
    normalizeUrlForMatching("https://example.com/page?utmx=1"),
    "https://example.com/page?utmx=1",
  );
});

Deno.test("normalizeUrlForMatching - strips well-known ad/click tracking IDs", () => {
  // Each of these is a pure tracking token and should be dropped.
  for (
    const param of [
      "fbclid=abc",
      "gclid=abc",
      "gbraid=abc",
      "wbraid=abc",
      "dclid=abc",
      "msclkid=abc",
      "ttclid=abc",
      "twclid=abc",
      "yclid=abc",
      "igshid=abc",
    ]
  ) {
    assertEquals(
      normalizeUrlForMatching(`https://example.com/article?${param}`),
      "https://example.com/article",
      `expected ${param} to be stripped`,
    );
  }
});

Deno.test("normalizeUrlForMatching - strips tracking IDs but keeps meaningful params", () => {
  assertEquals(
    normalizeUrlForMatching(
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ&fbclid=xyz",
    ),
    "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
  );
});

Deno.test("normalizeUrlForMatching - same URL differing only in click ID matches", () => {
  assertEquals(
    normalizeUrlForMatching("https://example.com/post?gclid=aaa"),
    normalizeUrlForMatching("https://example.com/post?fbclid=bbb"),
  );
});

Deno.test("normalizeUrlForMatching - UTM-only URL normalizes to the bare URL (no trailing ?)", () => {
  assertEquals(
    normalizeUrlForMatching("https://example.com/page?utm_source=x"),
    normalizeUrlForMatching("https://example.com/page"),
  );
  assertEquals(
    normalizeUrlForMatching("https://example.com/page?utm_source=x"),
    "https://example.com/page",
  );
});

Deno.test("normalizeUrlForMatching - strips fragments", () => {
  assertEquals(
    normalizeUrlForMatching("https://example.com/page#section-2"),
    "https://example.com/page",
  );
});

Deno.test("normalizeUrlForMatching - fragment strip keeps meaningful params intact", () => {
  assertEquals(
    normalizeUrlForMatching("https://example.com/article?page=2#section-1"),
    normalizeUrlForMatching("https://example.com/article?page=2#section-2"),
  );
  assertEquals(
    normalizeUrlForMatching("https://example.com/article?page=2#section-1"),
    "https://example.com/article?page=2",
  );
});

Deno.test("normalizeUrlForMatching - preserves trailing slash", () => {
  assertEquals(
    normalizeUrlForMatching("https://example.com/"),
    "https://example.com/",
  );
});

Deno.test("normalizeUrlForMatching - preserves port numbers", () => {
  assertEquals(
    normalizeUrlForMatching("https://example.com:8080/page"),
    "https://example.com:8080/page",
  );
});

Deno.test("normalizeUrlForMatching - handles HTTP protocol", () => {
  assertEquals(
    normalizeUrlForMatching("http://example.com/page"),
    "http://example.com/page",
  );
});

Deno.test("normalizeUrlForMatching - returns null for invalid URLs", () => {
  assertEquals(normalizeUrlForMatching("not-a-url"), null);
  assertEquals(normalizeUrlForMatching(""), null);
});

Deno.test("normalizeUrlForMatching - same URL differing only in UTM matches", () => {
  const url1 = normalizeUrlForMatching(
    "https://example.com/article?utm_source=google",
  );
  const url2 = normalizeUrlForMatching(
    "https://example.com/article?utm_source=newsletter&utm_campaign=spring",
  );
  assertEquals(url1, url2);
});

Deno.test("normalizeUrlForMatching - different meaningful params do NOT match", () => {
  const url1 = normalizeUrlForMatching("https://example.com/article?page=1");
  const url2 = normalizeUrlForMatching("https://example.com/article?page=2");
  assertEquals(url1 === url2, false);
});

Deno.test("normalizeUrlForMatching - different paths do not match", () => {
  const url1 = normalizeUrlForMatching("https://example.com/page1");
  const url2 = normalizeUrlForMatching("https://example.com/page2");
  assertEquals(url1 === url2, false);
});

// Regression: reported via Bluesky (feliciarondo.com). YouTube videos saved as
// /watch?v=<id> carry their identity entirely in the `v` query param. Stripping
// the whole query string collapsed every distinct video onto /watch, so they
// were all flagged as duplicates of each other.
Deno.test("normalizeUrlForMatching - distinct YouTube videos do not match", () => {
  const url1 = normalizeUrlForMatching(
    "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
  );
  const url2 = normalizeUrlForMatching(
    "https://www.youtube.com/watch?v=oHg5SJYRHA0",
  );
  assertEquals(url1, "https://www.youtube.com/watch?v=dQw4w9WgXcQ");
  assertEquals(url1 === url2, false);
});

Deno.test("normalizeUrlForMatching - same YouTube video with UTM still matches", () => {
  const url1 = normalizeUrlForMatching(
    "https://www.youtube.com/watch?v=dQw4w9WgXcQ&utm_source=share",
  );
  const url2 = normalizeUrlForMatching(
    "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
  );
  assertEquals(url1, url2);
});
