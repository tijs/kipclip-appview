/**
 * Tests for recent-tags localStorage helpers and pure reducer.
 * Uses a localStorage mock since Deno doesn't provide one.
 */

import { assertEquals } from "@std/assert";
import {
  loadRecentTags,
  MAX_RECENT_TAGS,
  nextRecentTags,
  saveRecentTags,
} from "../frontend/utils/recent-tags.ts";

const STORAGE_KEY = "kipclip:recent-tags";

function mockLocalStorage(): {
  restore: () => void;
  store: Map<string, string>;
} {
  const store = new Map<string, string>();
  const original = globalThis.localStorage;

  Object.defineProperty(globalThis, "localStorage", {
    value: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => store.set(key, value),
      removeItem: (key: string) => store.delete(key),
      clear: () => store.clear(),
      get length() {
        return store.size;
      },
      key: (_index: number) => null,
    },
    writable: true,
    configurable: true,
  });

  return {
    store,
    restore: () => {
      Object.defineProperty(globalThis, "localStorage", {
        value: original,
        writable: true,
        configurable: true,
      });
    },
  };
}

// ============================================================================
// nextRecentTags (pure reducer)

Deno.test("nextRecentTags inserts a new tag at the front of an empty list", () => {
  assertEquals(nextRecentTags([], "swift"), ["swift"]);
});

Deno.test("nextRecentTags inserts a new tag at the front when list is non-empty", () => {
  assertEquals(nextRecentTags(["swift"], "ai"), ["ai", "swift"]);
});

Deno.test("nextRecentTags moves an existing tag to the front without duplicating", () => {
  assertEquals(
    nextRecentTags(["c", "b", "swift", "a"], "swift"),
    ["swift", "c", "b", "a"],
  );
});

Deno.test("nextRecentTags dedupes case-insensitively and keeps the new casing", () => {
  assertEquals(
    nextRecentTags(["swift", "ai"], "Swift"),
    ["Swift", "ai"],
  );
});

Deno.test("nextRecentTags clips to MAX_RECENT_TAGS when adding the (N+1)th", () => {
  const seven = ["a", "b", "c", "d", "e", "f", "g"];
  // Add 8th: stays at MAX.
  const eight = nextRecentTags(seven, "h");
  assertEquals(eight.length, MAX_RECENT_TAGS);
  assertEquals(eight[0], "h");
  // Add 9th: drops the oldest (now at the tail).
  const nine = nextRecentTags(eight, "i");
  assertEquals(nine.length, MAX_RECENT_TAGS);
  assertEquals(nine[0], "i");
  assertEquals(nine.includes("g"), false, "oldest entry should be dropped");
});

Deno.test("nextRecentTags ignores empty/whitespace input", () => {
  assertEquals(nextRecentTags(["swift"], ""), ["swift"]);
  assertEquals(nextRecentTags(["swift"], "   "), ["swift"]);
});

Deno.test("nextRecentTags trims input before storing and comparing", () => {
  assertEquals(nextRecentTags(["swift"], "  ai  "), ["ai", "swift"]);
});

Deno.test("nextRecentTags trim + case-insensitive dedupe combine", () => {
  assertEquals(
    nextRecentTags(["swift", "ai"], "  SWIFT  "),
    ["SWIFT", "ai"],
  );
});

Deno.test("MAX_RECENT_TAGS is 8 (canary — bump deliberately if changing)", () => {
  assertEquals(MAX_RECENT_TAGS, 8);
});

// ============================================================================
// loadRecentTags

Deno.test("loadRecentTags returns [] when nothing stored", () => {
  const mock = mockLocalStorage();
  try {
    assertEquals(loadRecentTags(), []);
  } finally {
    mock.restore();
  }
});

Deno.test("loadRecentTags returns stored array of strings", () => {
  const mock = mockLocalStorage();
  try {
    mock.store.set(STORAGE_KEY, JSON.stringify(["swift", "ai"]));
    assertEquals(loadRecentTags(), ["swift", "ai"]);
  } finally {
    mock.restore();
  }
});

Deno.test("loadRecentTags returns [] on corrupt JSON", () => {
  const mock = mockLocalStorage();
  try {
    mock.store.set(STORAGE_KEY, "not json");
    assertEquals(loadRecentTags(), []);
  } finally {
    mock.restore();
  }
});

Deno.test("loadRecentTags returns [] when stored value is not an array", () => {
  const mock = mockLocalStorage();
  try {
    mock.store.set(STORAGE_KEY, JSON.stringify({ swift: true }));
    assertEquals(loadRecentTags(), []);
  } finally {
    mock.restore();
  }
});

Deno.test("loadRecentTags filters out non-string array entries", () => {
  const mock = mockLocalStorage();
  try {
    mock.store.set(STORAGE_KEY, JSON.stringify(["swift", 42, null, "ai"]));
    assertEquals(loadRecentTags(), ["swift", "ai"]);
  } finally {
    mock.restore();
  }
});

// ============================================================================
// saveRecentTags

Deno.test("saveRecentTags persists tags to localStorage", () => {
  const mock = mockLocalStorage();
  try {
    saveRecentTags(["swift", "ai"]);
    assertEquals(mock.store.get(STORAGE_KEY), JSON.stringify(["swift", "ai"]));
  } finally {
    mock.restore();
  }
});

Deno.test("saveRecentTags then loadRecentTags round-trips correctly", () => {
  const mock = mockLocalStorage();
  try {
    saveRecentTags(["swift", "ai", "atproto"]);
    assertEquals(loadRecentTags(), ["swift", "ai", "atproto"]);
  } finally {
    mock.restore();
  }
});

Deno.test("saveRecentTags swallows quota-exceeded errors", () => {
  const original = globalThis.localStorage;
  Object.defineProperty(globalThis, "localStorage", {
    value: {
      getItem: () => null,
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
      removeItem: () => {},
      clear: () => {},
      get length() {
        return 0;
      },
      key: () => null,
    },
    writable: true,
    configurable: true,
  });
  try {
    // Must not throw.
    saveRecentTags(["swift"]);
  } finally {
    Object.defineProperty(globalThis, "localStorage", {
      value: original,
      writable: true,
      configurable: true,
    });
  }
});

Deno.test("loadRecentTags returns [] when localStorage is undefined (SSR)", () => {
  const original = globalThis.localStorage;
  Object.defineProperty(globalThis, "localStorage", {
    value: undefined,
    writable: true,
    configurable: true,
  });
  try {
    assertEquals(loadRecentTags(), []);
  } finally {
    Object.defineProperty(globalThis, "localStorage", {
      value: original,
      writable: true,
      configurable: true,
    });
  }
});
