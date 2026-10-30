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
  assertEquals(prepareLoginIdentifier("   "), {
    valid: false,
    error: "Handle is required",
  });
  assertEquals(prepareLoginIdentifier("@alice"), {
    valid: false,
    error: "Handle must include a domain (e.g., alice.bsky.social)",
  });
  assertEquals(prepareLoginIdentifier("@alice..example"), {
    valid: false,
    error: "Handle cannot contain consecutive dots",
  });
});
