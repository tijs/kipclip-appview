/**
 * Tests for lib/mirror-config.ts — MIRROR_MODE env parsing.
 */

import "./test-setup.ts";

import { assertEquals } from "@std/assert";
import { _resetMirrorModeCache, getMirrorMode } from "../lib/mirror-config.ts";

function withEnv(value: string | undefined, fn: () => void) {
  const prev = Deno.env.get("MIRROR_MODE");
  if (value === undefined) {
    Deno.env.delete("MIRROR_MODE");
  } else {
    Deno.env.set("MIRROR_MODE", value);
  }
  _resetMirrorModeCache();
  try {
    fn();
  } finally {
    if (prev === undefined) {
      Deno.env.delete("MIRROR_MODE");
    } else {
      Deno.env.set("MIRROR_MODE", prev);
    }
    _resetMirrorModeCache();
  }
}

Deno.test("getMirrorMode - defaults to off when unset", () => {
  withEnv(undefined, () => {
    assertEquals(getMirrorMode(), "off");
  });
});

Deno.test("getMirrorMode - returns off", () => {
  withEnv("off", () => assertEquals(getMirrorMode(), "off"));
});

Deno.test("getMirrorMode - returns read", () => {
  withEnv("read", () => assertEquals(getMirrorMode(), "read"));
});

Deno.test("getMirrorMode - returns only", () => {
  withEnv("only", () => assertEquals(getMirrorMode(), "only"));
});

Deno.test("getMirrorMode - case-insensitive", () => {
  withEnv("READ", () => assertEquals(getMirrorMode(), "read"));
  withEnv("Only", () => assertEquals(getMirrorMode(), "only"));
});

Deno.test("getMirrorMode - trims whitespace", () => {
  withEnv("  read  ", () => assertEquals(getMirrorMode(), "read"));
});

Deno.test("getMirrorMode - invalid value falls back to off", () => {
  withEnv("garbage", () => assertEquals(getMirrorMode(), "off"));
  withEnv("on", () => assertEquals(getMirrorMode(), "off"));
  withEnv("", () => assertEquals(getMirrorMode(), "off"));
});

Deno.test("getMirrorMode - memoised within a single resolution", () => {
  withEnv("read", () => {
    assertEquals(getMirrorMode(), "read");
    Deno.env.set("MIRROR_MODE", "off");
    assertEquals(getMirrorMode(), "read");
  });
});
