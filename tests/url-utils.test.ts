import { assertEquals } from "@std/assert";
import { getBaseUrl } from "../shared/url-utils.ts";

Deno.test("getBaseUrl - returns protocol, host, and path", () => {
  assertEquals(
    getBaseUrl("https://example.com/page"),
    "https://example.com/page",
  );
});

Deno.test("getBaseUrl - strips query parameters", () => {
  assertEquals(
    getBaseUrl("https://example.com/page?utm_source=google&ref=twitter"),
    "https://example.com/page",
  );
});

Deno.test("getBaseUrl - strips fragments", () => {
  assertEquals(
    getBaseUrl("https://example.com/page#section-2"),
    "https://example.com/page",
  );
});

Deno.test("getBaseUrl - strips both query params and fragments", () => {
  assertEquals(
    getBaseUrl("https://example.com/page?q=test#top"),
    "https://example.com/page",
  );
});

Deno.test("getBaseUrl - preserves trailing slash", () => {
  assertEquals(
    getBaseUrl("https://example.com/"),
    "https://example.com/",
  );
});

Deno.test("getBaseUrl - preserves port numbers", () => {
  assertEquals(
    getBaseUrl("https://example.com:8080/page"),
    "https://example.com:8080/page",
  );
});

Deno.test("getBaseUrl - handles HTTP protocol", () => {
  assertEquals(
    getBaseUrl("http://example.com/page"),
    "http://example.com/page",
  );
});

Deno.test("getBaseUrl - returns null for invalid URLs", () => {
  assertEquals(getBaseUrl("not-a-url"), null);
  assertEquals(getBaseUrl(""), null);
});

Deno.test("getBaseUrl - same base URL with different query params matches", () => {
  const url1 = getBaseUrl("https://example.com/article?utm_source=google");
  const url2 = getBaseUrl("https://example.com/article?page=2");
  assertEquals(url1, url2);
});

Deno.test("getBaseUrl - different paths do not match", () => {
  const url1 = getBaseUrl("https://example.com/page1");
  const url2 = getBaseUrl("https://example.com/page2");
  assertEquals(url1 === url2, false);
});
