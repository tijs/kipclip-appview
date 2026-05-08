/**
 * Tests for mirror/upserts.ts — idempotent upsert + delete helpers.
 */

import { clearMirrorTables, db } from "./mirror-test-setup.ts";
import {
  assertEquals,
  assertExists,
  assertNotEquals,
  assertRejects,
} from "@std/assert";
import {
  type BookmarkUpsert,
  deleteAnnotation,
  deleteBookmark,
  deletePreferences,
  deleteTag,
  upsertAnnotation,
  upsertBookmark,
  upsertPreferences,
  upsertTag,
  upsertTrackedDid,
} from "../mirror/upserts.ts";

const DID = "did:plc:test123";
const OTHER_DID = "did:plc:other999";

function bookmark(
  rkey: string,
  overrides: Partial<BookmarkUpsert> = {},
): BookmarkUpsert {
  return {
    uri: `at://${DID}/community.lexicon.bookmarks.bookmark/${rkey}`,
    did: DID,
    rkey,
    cid: `bafy${rkey}`,
    subject: `https://example.com/${rkey}`,
    createdAt: "2026-05-01T00:00:00.000Z",
    tags: ["news"],
    ...overrides,
  };
}

async function rowCount(table: string): Promise<number> {
  const r = await db.execute({
    sql: `SELECT COUNT(*) FROM ${table}`,
    args: [],
  });
  return Number((r.rows[0] as unknown[])[0]);
}

async function getBookmarkRow(uri: string) {
  const r = await db.execute({
    sql:
      "SELECT uri, did, cid, tags, enriched_title, pending_echo, updated_at FROM bookmarks WHERE uri = ?",
    args: [uri],
  });
  return r.rows[0] as (string | number | null)[] | undefined;
}

Deno.test("upsertBookmark - inserts a new bookmark", async () => {
  await clearMirrorTables();
  await upsertBookmark(bookmark("a"));
  assertEquals(await rowCount("bookmarks"), 1);
  const row = await getBookmarkRow(
    `at://${DID}/community.lexicon.bookmarks.bookmark/a`,
  );
  assertExists(row);
  assertEquals(row[2], "bafya");
  assertEquals(row[3], '["news"]');
  assertEquals(row[5], 0);
});

Deno.test("upsertBookmark - same (uri, cid) is no-op count-wise", async () => {
  await clearMirrorTables();
  await upsertBookmark(bookmark("b"));
  await upsertBookmark(bookmark("b"));
  assertEquals(await rowCount("bookmarks"), 1);
});

Deno.test("upsertBookmark - new CID for same URI updates row and updated_at", async () => {
  await clearMirrorTables();
  await upsertBookmark(bookmark("c"));
  const before = await getBookmarkRow(
    `at://${DID}/community.lexicon.bookmarks.bookmark/c`,
  );
  assertExists(before);
  await new Promise((r) => setTimeout(r, 5));
  await upsertBookmark(bookmark("c", { cid: "bafyNEW" }));
  const after = await getBookmarkRow(
    `at://${DID}/community.lexicon.bookmarks.bookmark/c`,
  );
  assertExists(after);
  assertEquals(after[2], "bafyNEW");
  assertNotEquals(after[6], before[6]);
});

Deno.test("upsertBookmark - empty tags stored as []", async () => {
  await clearMirrorTables();
  await upsertBookmark(bookmark("d", { tags: [] }));
  const row = await getBookmarkRow(
    `at://${DID}/community.lexicon.bookmarks.bookmark/d`,
  );
  assertExists(row);
  assertEquals(row[3], "[]");
});

Deno.test("upsertBookmark - undefined tags stored as []", async () => {
  await clearMirrorTables();
  await upsertBookmark(bookmark("e", { tags: undefined }));
  const row = await getBookmarkRow(
    `at://${DID}/community.lexicon.bookmarks.bookmark/e`,
  );
  assertExists(row);
  assertEquals(row[3], "[]");
});

Deno.test("upsertBookmark - null enriched fields stored as null", async () => {
  await clearMirrorTables();
  await upsertBookmark(
    bookmark("f", {
      enrichedTitle: null,
      enrichedDescription: null,
      enrichedFavicon: null,
      enrichedImage: null,
    }),
  );
  const row = await getBookmarkRow(
    `at://${DID}/community.lexicon.bookmarks.bookmark/f`,
  );
  assertExists(row);
  assertEquals(row[4], null);
});

Deno.test("upsertBookmark - rejects cross-DID URI", async () => {
  await clearMirrorTables();
  await assertRejects(
    () =>
      upsertBookmark(
        bookmark("g", {
          uri: `at://${OTHER_DID}/community.lexicon.bookmarks.bookmark/g`,
        }),
      ),
    Error,
    "cross-DID guard",
  );
  assertEquals(await rowCount("bookmarks"), 0);
});

Deno.test("deleteBookmark - removes the row", async () => {
  await clearMirrorTables();
  await upsertBookmark(bookmark("h"));
  await deleteBookmark(
    `at://${DID}/community.lexicon.bookmarks.bookmark/h`,
    DID,
  );
  assertEquals(await rowCount("bookmarks"), 0);
});

Deno.test("deleteBookmark - rejects cross-DID URI", async () => {
  await clearMirrorTables();
  await assertRejects(
    () =>
      deleteBookmark(
        `at://${OTHER_DID}/community.lexicon.bookmarks.bookmark/i`,
        DID,
      ),
    Error,
    "cross-DID guard",
  );
});

Deno.test("upsertAnnotation - inserts then updates idempotently", async () => {
  await clearMirrorTables();
  const subject = `at://${DID}/community.lexicon.bookmarks.bookmark/j`;
  const aUri = `at://${DID}/app.bookmark.annotation/j`;
  await upsertAnnotation({
    uri: aUri,
    did: DID,
    rkey: "j",
    cid: "bafyA",
    subject,
    note: "first",
  });
  await upsertAnnotation({
    uri: aUri,
    did: DID,
    rkey: "j",
    cid: "bafyB",
    subject,
    note: "second",
  });
  assertEquals(await rowCount("annotations"), 1);
  const r = await db.execute({
    sql: "SELECT cid, note FROM annotations WHERE uri = ?",
    args: [aUri],
  });
  assertEquals(r.rows[0], ["bafyB", "second"]);
});

Deno.test("deleteAnnotation - removes the row", async () => {
  await clearMirrorTables();
  const aUri = `at://${DID}/app.bookmark.annotation/k`;
  await upsertAnnotation({
    uri: aUri,
    did: DID,
    rkey: "k",
    cid: "bafyA",
    subject: `at://${DID}/community.lexicon.bookmarks.bookmark/k`,
  });
  await deleteAnnotation(aUri, DID);
  assertEquals(await rowCount("annotations"), 0);
});

Deno.test("upsertTag - inserts and updates value", async () => {
  await clearMirrorTables();
  const uri = `at://${DID}/com.kipclip.tag/l`;
  await upsertTag({
    uri,
    did: DID,
    rkey: "l",
    cid: "bafyT",
    value: "tech",
    createdAt: "2026-05-01T00:00:00.000Z",
  });
  await upsertTag({
    uri,
    did: DID,
    rkey: "l",
    cid: "bafyT2",
    value: "technology",
    createdAt: "2026-05-01T00:00:00.000Z",
  });
  const r = await db.execute({
    sql: "SELECT value, cid FROM tags WHERE uri = ?",
    args: [uri],
  });
  assertEquals(r.rows[0], ["technology", "bafyT2"]);
});

Deno.test("deleteTag - removes the row", async () => {
  await clearMirrorTables();
  const uri = `at://${DID}/com.kipclip.tag/m`;
  await upsertTag({
    uri,
    did: DID,
    rkey: "m",
    cid: "bafyT",
    value: "old",
    createdAt: "2026-05-01T00:00:00.000Z",
  });
  await deleteTag(uri, DID);
  assertEquals(await rowCount("tags"), 0);
});

Deno.test("upsertTrackedDid - inserts a new row", async () => {
  await clearMirrorTables();
  await upsertTrackedDid({ did: DID, pdsUrl: "https://pds.example" });
  const r = await db.execute({
    sql: "SELECT did, pds_url, last_seq FROM tracked_dids WHERE did = ?",
    args: [DID],
  });
  assertEquals(r.rows[0], [DID, "https://pds.example", null]);
});

Deno.test("upsertTrackedDid - last_seq advances monotonically", async () => {
  await clearMirrorTables();
  await upsertTrackedDid({ did: DID, lastSeq: 100, lastEventAt: 1000 });
  await upsertTrackedDid({ did: DID, lastSeq: 50, lastEventAt: 500 });
  const r = await db.execute({
    sql: "SELECT last_seq, last_event_at FROM tracked_dids WHERE did = ?",
    args: [DID],
  });
  assertEquals(r.rows[0], [100, 1000]);
});

Deno.test("upsertTrackedDid - backfill timestamps preserved when not provided", async () => {
  await clearMirrorTables();
  await upsertTrackedDid({
    did: DID,
    backfillStartedAt: 1000,
    backfillCompleteAt: 2000,
  });
  await upsertTrackedDid({ did: DID, lastSeq: 10 });
  const r = await db.execute({
    sql:
      "SELECT backfill_started_at, backfill_complete_at FROM tracked_dids WHERE did = ?",
    args: [DID],
  });
  assertEquals(r.rows[0], [1000, 2000]);
});

Deno.test("integration - bookmark + annotation share rkey, both queryable by DID", async () => {
  await clearMirrorTables();
  await upsertBookmark(bookmark("z"));
  await upsertAnnotation({
    uri: `at://${DID}/app.bookmark.annotation/z`,
    did: DID,
    rkey: "z",
    cid: "bafyZA",
    subject: `at://${DID}/community.lexicon.bookmarks.bookmark/z`,
    note: "important",
  });
  const r = await db.execute({
    sql: `
      SELECT b.uri, a.note FROM bookmarks b
      LEFT JOIN annotations a ON a.subject = b.uri
      WHERE b.did = ?
    `,
    args: [DID],
  });
  assertEquals(r.rows[0], [
    `at://${DID}/community.lexicon.bookmarks.bookmark/z`,
    "important",
  ]);
});

Deno.test("upsertPreferences - inserts a new row with both fields", async () => {
  await clearMirrorTables();
  await upsertPreferences({
    did: DID,
    cid: "bafyP1",
    dateFormat: "us",
    readingListTag: "toread",
  });
  const r = await db.execute({
    sql:
      "SELECT did, cid, date_format, reading_list_tag FROM preferences WHERE did = ?",
    args: [DID],
  });
  assertEquals(r.rows.length, 1);
  assertEquals(r.rows[0], [DID, "bafyP1", "us", "toread"]);
});

Deno.test("upsertPreferences - is idempotent on (did)", async () => {
  await clearMirrorTables();
  const record = {
    did: DID,
    cid: "bafyP1",
    dateFormat: "us",
    readingListTag: "toread",
  };
  await upsertPreferences(record);
  const r1 = await db.execute({
    sql: "SELECT updated_at FROM preferences WHERE did = ?",
    args: [DID],
  });
  await new Promise((resolve) => setTimeout(resolve, 5));
  await upsertPreferences(record);
  const r2 = await db.execute({
    sql: "SELECT COUNT(*), updated_at FROM preferences WHERE did = ?",
    args: [DID],
  });
  assertEquals(r2.rows[0][0], 1);
  assertNotEquals(r2.rows[0][1], r1.rows[0][0]);
});

Deno.test("upsertPreferences - update changes existing row", async () => {
  await clearMirrorTables();
  await upsertPreferences({
    did: DID,
    cid: "bafyP1",
    dateFormat: "us",
    readingListTag: "toread",
  });
  await upsertPreferences({
    did: DID,
    cid: "bafyP2",
    dateFormat: "iso",
    readingListTag: "later",
  });
  const r = await db.execute({
    sql:
      "SELECT cid, date_format, reading_list_tag FROM preferences WHERE did = ?",
    args: [DID],
  });
  assertEquals(r.rows[0], ["bafyP2", "iso", "later"]);
});

Deno.test("upsertPreferences - allows null fields", async () => {
  await clearMirrorTables();
  await upsertPreferences({
    did: DID,
    cid: "bafyP1",
  });
  const r = await db.execute({
    sql: "SELECT date_format, reading_list_tag FROM preferences WHERE did = ?",
    args: [DID],
  });
  assertEquals(r.rows[0], [null, null]);
});

Deno.test("deletePreferences - removes the row", async () => {
  await clearMirrorTables();
  await upsertPreferences({
    did: DID,
    cid: "bafyP1",
    dateFormat: "us",
  });
  await deletePreferences(DID);
  const r = await db.execute({
    sql: "SELECT COUNT(*) FROM preferences WHERE did = ?",
    args: [DID],
  });
  assertEquals(r.rows[0][0], 0);
});
