/**
 * Tests for mirrorRead semantics in the queries layer.
 *
 * mirrorRead now always uses the primary db — there is no fallback path.
 * These tests verify that:
 *   - mirrorRead always routes to the primary db regardless of MIRROR_DUAL_WRITE
 *   - getMirrorInitialExtras uses the primary db directly
 *   - Cross-DID isolation is preserved through the wrapper
 *
 * The old local→Turso fallback behavior (flag on + local throws → Turso
 * serves) no longer exists; those tests are removed.
 */

import "./test-setup.ts";
import { clearMirrorTables } from "./mirror-test-setup.ts";

import { assertEquals, assertExists } from "@std/assert";
import { mirrorRead } from "../lib/db.ts";
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

function setFlag(on: boolean) {
  if (on) Deno.env.set("MIRROR_DUAL_WRITE", "on");
  else Deno.env.delete("MIRROR_DUAL_WRITE");
}

Deno.test("mirrorRead - always uses primary db regardless of flag", async () => {
  setFlag(false);
  const r = await mirrorRead((client) =>
    client.execute({ sql: "SELECT 1 AS x", args: [] })
  );
  assertExists(r);
  assertEquals(r.rows[0][0], 1);

  // Same with flag on — still uses primary db.
  setFlag(true);
  const r2 = await mirrorRead((client) =>
    client.execute({ sql: "SELECT 2 AS x", args: [] })
  );
  assertExists(r2);
  assertEquals(r2.rows[0][0], 2);
  setFlag(false);
});

Deno.test("getSyncStatus - reads from primary db", async () => {
  await clearMirrorTables();
  await upsertTrackedDid({
    did: DID,
    backfillStartedAt: 1,
    backfillCompleteAt: 2,
  });

  const status = await getSyncStatus(DID);
  assertEquals(status.tracking, true);
  assertEquals(status.backfillStartedAt, 1);
});

Deno.test("listAllBookmarks - cross-DID isolation preserved through mirrorRead", async () => {
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

  const bookmarks = await listAllBookmarks(DID);
  assertEquals(bookmarks.length, 1);
  assertEquals(bookmarks[0].uri.includes(DID), true);
});

Deno.test("firstPageBookmarks - returns mirror data from primary db", async () => {
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

  const page = await firstPageBookmarks(DID);
  assertEquals(page.bookmarks.length, 1);
});

Deno.test("listTags - returns tags from primary db", async () => {
  await clearMirrorTables();
  await upsertTag({
    uri: `at://${DID}/com.kipclip.tag/t1`,
    did: DID,
    rkey: "t1",
    cid: "t1",
    value: "Rust",
    createdAt: "2026-05-04T00:00:00Z",
  });

  const tags = await listTags(DID);
  assertEquals(tags.length, 1);
  assertEquals(tags[0].value, "Rust");
});

Deno.test("getMirrorInitialExtras - uses primary db directly", async () => {
  await clearMirrorTables();

  // Insert a tracked_did row so there's some state, but user_settings is
  // on the primary — this just verifies the query runs without error.
  const extras = await getMirrorInitialExtras(DID);
  // Defaults when no rows: enabled=false, prefs=null.
  assertEquals(extras.instapaperEnabled, false);
  assertEquals(extras.preferences, null);
});

Deno.test("mirrorRead - db client executes queries correctly", async () => {
  await clearMirrorTables();
  await upsertTrackedDid({ did: DID, backfillStartedAt: 42 });

  const r = await mirrorRead((client) =>
    client.execute({
      sql: "SELECT backfill_started_at FROM tracked_dids WHERE did = ?",
      args: [DID],
    })
  );
  assertEquals(r.rows.length, 1);
  assertEquals(Number(r.rows[0][0]), 42);
});
