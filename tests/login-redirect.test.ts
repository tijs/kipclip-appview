import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { buildLoginRedirectUrl } from "../shared/login-redirect.ts";

// Regression: the bookmarklet/share `/save` popup once pointed unauthenticated
// users at `/?redirect=...`. After the homepage redesign the login form moved
// off `/`, so visitors landed on the marketing page with no path back to the
// save flow. The helper must always route through `/signin`.

Deno.test("buildLoginRedirectUrl - always targets /signin, never /", () => {
  const url = buildLoginRedirectUrl("/save", "?url=https%3A%2F%2Fexample.com");
  assert(
    url.startsWith("/signin?"),
    `expected /signin prefix, got: ${url}`,
  );
  assert(
    !url.startsWith("/?"),
    `must not point at homepage, got: ${url}`,
  );
});

Deno.test("buildLoginRedirectUrl - preserves pathname + search in redirect", () => {
  const url = buildLoginRedirectUrl("/save", "?url=https%3A%2F%2Fexample.com");
  assertEquals(
    url,
    "/signin?redirect=%2Fsave%3Furl%3Dhttps%253A%252F%252Fexample.com",
  );
});

Deno.test("buildLoginRedirectUrl - decoded redirect round-trips to original path", () => {
  const original = "/save?url=https://example.com/page?q=1&r=2#frag";
  const url = buildLoginRedirectUrl(
    "/save",
    "?url=https://example.com/page?q=1&r=2#frag",
  );
  const params = new URLSearchParams(url.split("?")[1]);
  assertEquals(params.get("redirect"), original);
});

Deno.test("buildLoginRedirectUrl - empty search still produces valid /signin URL", () => {
  const url = buildLoginRedirectUrl("/save", "");
  assertEquals(url, "/signin?redirect=%2Fsave");
});

Deno.test("buildLoginRedirectUrl - special characters in URL get encoded", () => {
  const url = buildLoginRedirectUrl("/save", "?url=https://x.com/?a=b&c=d");
  assertStringIncludes(url, "%3F");
  assertStringIncludes(url, "%26");
});
