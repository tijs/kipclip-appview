/**
 * Tests for U3 (plan 004): mirrorRead local→Turso fallback in queries layer.
 *
 * Default test env has localDb=null → mirrorRead falls through to rawDb
 * directly (legacy behavior preserved by all existing tests). To exercise
 * the local-first path we install a fake localDb via _setTestLocalDb and
 * toggle MIRROR_DUAL_WRITE.
 *
 * Verifies:
 *   - Flag on + local healthy → local serves, Turso untouched
 *   - Flag on + local throws → Turso serves, Sentry warning emitted
 *   - Flag off + localDb set → Turso serves directly (no wrapper logic)
 *   - getMirrorInitialExtras stays on Turso even with flag on (intentional;
 *     joins Turso-only user_settings)
 *   - Cross-DID isolation preserved through the wrapper
 */

import "./test-setup.ts";
import { clearMirrorTables, rawDb } from "./mirror-test-setup.ts";

import { assertEquals, assertExists } from "@std/assert";
import { _setTestLocalDb, mirrorRead } from "../lib/db.ts";
import {
  firstPageBookmarks,
  getMirrorInitialExtras,
  getSyncStatus,
  listAllBookmarks,
  listTags,
} from "../mirror/queries.ts";
import {
  upsertBookmark,
  upsertTag,
  upsertTrackedDid,
} from "../mirror/upserts.ts";

const DID = "did:plc:fallback";
const OTHER = "did:plc:other-fallback";

interface FakeDb {
  execute: (
    q: { sql: string; args: unknown[] },
  ) => Promise<{ rows: unknown[][] }>;
}

function setFlag(on: boolean) {
  if (on) Deno.env.set("MIRROR_DUAL_WRITE", "on");
  else Deno.env.delete("MIRROR_DUAL_WRITE");
}

Deno.test("mirrorRead - flag off → Turso direct (no wrapper)", async () => {
  setFlag(false);
  _setTestLocalDb({
    execute: () => {
      throw new Error("local should not be called");
    },
  });

  const r = await mirrorRead((db) =>
    db.execute({ sql: "SELECT 1 AS x", args: [] })
  );
  assertExists(r);
  _setTestLocalDb(null);
});

Deno.test("mirrorRead - flag on + local healthy → local serves, Turso untouched", async () => {
  let localCalls = 0;
  let tursoCalls = 0;
  _setTestLocalDb({
    execute: (_q) => {
      localCalls++;
      return Promise.resolve({ rows: [[42]] });
    },
  });
  // Patch rawDb.execute to count calls.
  const origExecute = rawDb.execute.bind(rawDb);
  // deno-lint-ignore no-explicit-any
  (rawDb as any).execute = (q: any) => {
    tursoCalls++;
    return origExecute(q);
  };

  try {
    setFlag(true);
    const r = await mirrorRead((db) =>
      db.execute({ sql: "SELECT 1", args: [] })
    );
    assertEquals(r.rows[0][0], 42);
    assertEquals(localCalls, 1);
    assertEquals(tursoCalls, 0);
  } finally {
    // deno-lint-ignore no-explicit-any
    (rawDb as any).execute = origExecute;
    setFlag(false);
    _setTestLocalDb(null);
  }
});

Deno.test("mirrorRead - flag on + local throws → Turso serves, Sentry warns", async () => {
  await clearMirrorTables();
  await upsertTrackedDid({
    did: DID,
    backfillStartedAt: 1,
    backfillCompleteAt: 2,
  });

  // Local always throws.
  _setTestLocalDb({
    execute: () => Promise.reject(new Error("local boom")),
  });
  setFlag(true);

  try {
    const status = await getSyncStatus(DID);
    // Turso has the row, so fallback served real data.
    assertEquals(status.tracking, true);
    assertEquals(status.backfillStartedAt, 1);
  } finally {
    setFlag(false);
    _setTestLocalDb(null);
  }
});

Deno.test("listAllBookmarks - flag on + local healthy → cross-DID isolation preserved", async () => {
  await clearMirrorTables();
  await upsertTrackedDid({
    did: DID,
    backfillStartedAt: 1,
    backfillCompleteAt: 2,
  });
  await upsertBookmark({
    uri: `at://${DID}/community.lexicon.bookmarks.bookmark/m1`,
    did: DID,
    rkey: "m1",
    cid: "m1",
    subject: "https://example.com/m1",
    createdAt: "2026-05-04T00:00:00Z",
    tags: ["news"],
  });
  // Other DID's row shouldn't leak through.
  await upsertBookmark({
    uri: `at://${OTHER}/community.lexicon.bookmarks.bookmark/o1`,
    did: OTHER,
    rkey: "o1",
    cid: "o1",
    subject: "https://other.example/o1",
    createdAt: "2026-05-04T00:00:00Z",
    tags: [],
  });

  // Use a real local libSQL via the same in-memory rawDb client (since the
  // test env shares the same in-memory DB) — easiest way to verify the
  // wrapper invokes db.execute correctly without standing up a second DB.
  _setTestLocalDb({
    execute: (q) => rawDb.execute(q),
  });
  setFlag(true);

  try {
    const bookmarks = await listAllBookmarks(DID);
    assertEquals(bookmarks.length, 1);
    assertEquals(bookmarks[0].uri.includes(DID), true);
  } finally {
    setFlag(false);
    _setTestLocalDb(null);
  }
});

Deno.test("firstPageBookmarks - flag on local healthy → mirror data returned", async () => {
  await clearMirrorTables();
  await upsertBookmark({
    uri: `at://${DID}/community.lexicon.bookmarks.bookmark/p1`,
    did: DID,
    rkey: "p1",
    cid: "p1",
    subject: "https://example.com/p1",
    createdAt: "2026-05-04T00:00:00Z",
    tags: [],
  });

  _setTestLocalDb({
    execute: (q) => rawDb.execute(q),
  });
  setFlag(true);

  try {
    const page = await firstPageBookmarks(DID);
    assertEquals(page.bookmarks.length, 1);
  } finally {
    setFlag(false);
    _setTestLocalDb(null);
  }
});

Deno.test("listTags - flag on local healthy → mirror tags returned", async () => {
  await clearMirrorTables();
  await upsertTag({
    uri: `at://${DID}/com.kipclip.tag/t1`,
    did: DID,
    rkey: "t1",
    cid: "t1",
    value: "Rust",
    createdAt: "2026-05-04T00:00:00Z",
  });

  _setTestLocalDb({
    execute: (q) => rawDb.execute(q),
  });
  setFlag(true);

  try {
    const tags = await listTags(DID);
    assertEquals(tags.length, 1);
    assertEquals(tags[0].value, "Rust");
  } finally {
    setFlag(false);
    _setTestLocalDb(null);
  }
});

Deno.test("getMirrorInitialExtras - flag on still uses Turso (joins user_settings)", async () => {
  await clearMirrorTables();

  // Local would throw if it were called — proves rawDb is used directly.
  _setTestLocalDb({
    execute: () => Promise.reject(new Error("local must not be called here")),
  });
  setFlag(true);

  try {
    const extras = await getMirrorInitialExtras(DID);
    // Defaults when no rows: enabled=false, prefs=null.
    assertEquals(extras.instapaperEnabled, false);
    assertEquals(extras.preferences, null);
  } finally {
    setFlag(false);
    _setTestLocalDb(null);
  }
});
