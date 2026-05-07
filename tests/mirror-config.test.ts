/**
 * Tests for lib/mirror-config.ts — MIRROR_MODE env parsing.
 */

import "./test-setup.ts";
import "./mirror-test-setup.ts"; // ensures tracked_dids table exists for shouldReadFromMirror tests below

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

Deno.test("getMirrorMode - legacy 'only' falls back to off", () => {
  withEnv("only", () => assertEquals(getMirrorMode(), "off"));
  withEnv("Only", () => assertEquals(getMirrorMode(), "off"));
});

Deno.test("getMirrorMode - case-insensitive", () => {
  withEnv("READ", () => assertEquals(getMirrorMode(), "read"));
  withEnv("OFF", () => assertEquals(getMirrorMode(), "off"));
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

// ---------------------------------------------------------------------------
// shouldReadFromMirror: Turso-failure → PDS fallback
// ---------------------------------------------------------------------------

import { rawDb } from "../lib/db.ts";
import {
  _resetSyncStatusCache,
  shouldReadFromMirror,
} from "../lib/mirror-config.ts";

Deno.test("shouldReadFromMirror - getSyncStatus throws → fromMirror=false (Turso outage degrades to PDS, not 500)", async () => {
  Deno.env.set("MIRROR_MODE", "read");
  _resetMirrorModeCache();
  _resetSyncStatusCache();

  const orig = rawDb.execute.bind(rawDb);
  // Throw on the tracked_dids select that backs getSyncStatus; let other
  // queries (migrations, etc.) succeed.
  // deno-lint-ignore no-explicit-any
  (rawDb as any).execute = (q: any) => {
    if (typeof q?.sql === "string" && q.sql.includes("FROM tracked_dids")) {
      throw new Error("turso boom");
    }
    return orig(q);
  };

  try {
    const decision = await shouldReadFromMirror("did:plc:tursoboom");
    assertEquals(decision.fromMirror, false);
    assertEquals(decision.syncing, false);
    assertEquals(decision.status.tracking, false);
  } finally {
    // deno-lint-ignore no-explicit-any
    (rawDb as any).execute = orig;
    Deno.env.delete("MIRROR_MODE");
    _resetMirrorModeCache();
    _resetSyncStatusCache();
  }
});

Deno.test("shouldReadFromMirror - second call within TTL reuses cached promise", async () => {
  Deno.env.set("MIRROR_MODE", "read");
  _resetMirrorModeCache();
  _resetSyncStatusCache();

  try {
    // Two back-to-back calls for the same DID should resolve the same
    // status row. The cache shape (Map<did, {promise, cachedAt}>) means
    // both calls await the same in-flight promise — the second call must
    // not race a fresh getSyncStatus while the first is still pending.
    // We verify behaviorally: both calls return equivalent decisions for
    // a DID that goes from untracked to tracked between the calls
    // (without an explicit cache reset).
    const before = await shouldReadFromMirror("did:plc:cachehit");
    assertEquals(before.fromMirror, false);

    // Insert a tracked_dids row directly. If the cache is honored (TTL
    // 1000ms), the next shouldReadFromMirror still returns
    // fromMirror=false because it serves the cached pre-insert status.
    await rawDb.execute({
      sql: `INSERT INTO tracked_dids (did, pds_url, added_at,
              backfill_started_at, backfill_complete_at)
            VALUES (?, ?, ?, ?, ?)`,
      args: ["did:plc:cachehit", "https://pds.example", 1, 2, 3],
    });

    const after = await shouldReadFromMirror("did:plc:cachehit");
    assertEquals(
      after.fromMirror,
      false,
      "Cache TTL should mask the new tracked row within the 1s window",
    );
  } finally {
    await rawDb.execute({
      sql: "DELETE FROM tracked_dids WHERE did = ?",
      args: ["did:plc:cachehit"],
    });
    Deno.env.delete("MIRROR_MODE");
    _resetMirrorModeCache();
    _resetSyncStatusCache();
  }
});
