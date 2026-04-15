/**
 * Tests for saved login identities utility.
 * Uses a localStorage mock since Deno doesn't provide one.
 */

import { assertEquals } from "@std/assert";
import {
  getSavedIdentities,
  removeIdentity,
  saveIdentity,
} from "../frontend/utils/saved-identities.ts";

// Simple localStorage mock
function mockLocalStorage(): { restore: () => void } {
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
// getSavedIdentities

Deno.test("getSavedIdentities returns empty array when nothing stored", () => {
  const mock = mockLocalStorage();
  try {
    assertEquals(getSavedIdentities(), []);
  } finally {
    mock.restore();
  }
});

Deno.test("getSavedIdentities returns stored identities", () => {
  const mock = mockLocalStorage();
  try {
    const identities = [
      { handle: "alice.bsky.social", did: "did:plc:alice" },
    ];
    localStorage.setItem(
      "kipclip-saved-identities",
      JSON.stringify(identities),
    );
    assertEquals(getSavedIdentities(), identities);
  } finally {
    mock.restore();
  }
});

Deno.test("getSavedIdentities ignores invalid JSON", () => {
  const mock = mockLocalStorage();
  try {
    localStorage.setItem("kipclip-saved-identities", "not json");
    assertEquals(getSavedIdentities(), []);
  } finally {
    mock.restore();
  }
});

Deno.test("getSavedIdentities filters out malformed entries", () => {
  const mock = mockLocalStorage();
  try {
    localStorage.setItem(
      "kipclip-saved-identities",
      JSON.stringify([
        { handle: "alice.bsky.social", did: "did:plc:alice" },
        { handle: 123 }, // invalid
        null, // invalid
        { handle: "bob.bsky.social", did: "did:plc:bob" },
      ]),
    );
    assertEquals(getSavedIdentities(), [
      { handle: "alice.bsky.social", did: "did:plc:alice" },
      { handle: "bob.bsky.social", did: "did:plc:bob" },
    ]);
  } finally {
    mock.restore();
  }
});

// ============================================================================
// saveIdentity

Deno.test("saveIdentity adds a new identity", () => {
  const mock = mockLocalStorage();
  try {
    saveIdentity("alice.bsky.social", "did:plc:alice");
    assertEquals(getSavedIdentities(), [
      { handle: "alice.bsky.social", did: "did:plc:alice" },
    ]);
  } finally {
    mock.restore();
  }
});

Deno.test("saveIdentity moves existing DID to front and updates handle", () => {
  const mock = mockLocalStorage();
  try {
    saveIdentity("alice.bsky.social", "did:plc:alice");
    saveIdentity("bob.bsky.social", "did:plc:bob");
    // Alice logs in again with a new handle
    saveIdentity("alice.com", "did:plc:alice");
    assertEquals(getSavedIdentities(), [
      { handle: "alice.com", did: "did:plc:alice" },
      { handle: "bob.bsky.social", did: "did:plc:bob" },
    ]);
  } finally {
    mock.restore();
  }
});

Deno.test("saveIdentity caps at 5 identities", () => {
  const mock = mockLocalStorage();
  try {
    for (let i = 0; i < 7; i++) {
      saveIdentity(`user${i}.bsky.social`, `did:plc:user${i}`);
    }
    const saved = getSavedIdentities();
    assertEquals(saved.length, 5);
    // Most recent should be first
    assertEquals(saved[0].handle, "user6.bsky.social");
    assertEquals(saved[4].handle, "user2.bsky.social");
  } finally {
    mock.restore();
  }
});

// ============================================================================
// removeIdentity

Deno.test("removeIdentity removes by DID", () => {
  const mock = mockLocalStorage();
  try {
    saveIdentity("alice.bsky.social", "did:plc:alice");
    saveIdentity("bob.bsky.social", "did:plc:bob");
    removeIdentity("did:plc:alice");
    assertEquals(getSavedIdentities(), [
      { handle: "bob.bsky.social", did: "did:plc:bob" },
    ]);
  } finally {
    mock.restore();
  }
});

Deno.test("removeIdentity cleans up storage key when empty", () => {
  const mock = mockLocalStorage();
  try {
    saveIdentity("alice.bsky.social", "did:plc:alice");
    removeIdentity("did:plc:alice");
    assertEquals(localStorage.getItem("kipclip-saved-identities"), null);
  } finally {
    mock.restore();
  }
});

Deno.test("removeIdentity is a no-op for unknown DID", () => {
  const mock = mockLocalStorage();
  try {
    saveIdentity("alice.bsky.social", "did:plc:alice");
    removeIdentity("did:plc:unknown");
    assertEquals(getSavedIdentities(), [
      { handle: "alice.bsky.social", did: "did:plc:alice" },
    ]);
  } finally {
    mock.restore();
  }
});
