import { assertEquals } from "@std/assert";
import { prepareLoginIdentifier } from "../shared/login-handle.ts";

Deno.test("login identifiers accept one optional leading at sign", () => {
  for (
    const input of [
      "alice.bsky.social",
      "@alice.bsky.social",
      "  @alice.bsky.social  ",
    ]
  ) {
    assertEquals(prepareLoginIdentifier(input), {
      valid: true,
      value: "alice.bsky.social",
    });
  }
  for (
    const input of [
      "@@alice.bsky.social",
      "@alice..example",
      "@alice example.com",
      "@",
    ]
  ) {
    assertEquals(prepareLoginIdentifier(input).valid, false);
  }
  assertEquals(prepareLoginIdentifier("  https://bsky.social  "), {
    valid: true,
    value: "https://bsky.social",
  });
});
