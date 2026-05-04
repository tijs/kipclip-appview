/**
 * Tests for mirror/queries.ts — read-side queries used by route handlers.
 */

import { clearMirrorTables } from "./mirror-test-setup.ts";
import { assertEquals, assertExists } from "@std/assert";
import {
  firstPageBookmarks,
  getBookmark,
  getMirrorPreferences,
  getSyncStatus,
  listTags,
  nextPageBookmarks,
} from "../mirror/queries.ts";
import {
  upsertAnnotation,
  upsertBookmark,
  upsertPreferences,
  upsertTag,
  upsertTrackedDid,
} from "../mirror/upserts.ts";

const DID = "did:plc:test123";
const OTHER_DID = "did:plc:other999";

function bUri(rkey: string, did: string = DID): string {
  return `at://${did}/community.lexicon.bookmarks.bookmark/${rkey}`;
}

async function seedBookmark(
  rkey: string,
  createdAt: string,
  did: string = DID,
) {
  await upsertBookmark({
    uri: bUri(rkey, did),
    did,
    rkey,
    cid: `bafy${rkey}`,
    subject: `https://example.com/${rkey}`,
    createdAt,
    tags: ["news"],
  });
}

Deno.test("firstPageBookmarks - empty mirror returns []", async () => {
  await clearMirrorTables();
  const r = await firstPageBookmarks(DID);
  assertEquals(r.bookmarks, []);
  assertEquals(r.cursor, undefined);
});

Deno.test("firstPageBookmarks - returns newest first", async () => {
  await clearMirrorTables();
  await seedBookmark("a", "2026-05-01T00:00:00.000Z");
  await seedBookmark("b", "2026-05-03T00:00:00.000Z");
  await seedBookmark("c", "2026-05-02T00:00:00.000Z");
  const r = await firstPageBookmarks(DID);
  assertEquals(r.bookmarks.length, 3);
  assertEquals(r.bookmarks[0].uri, bUri("b"));
  assertEquals(r.bookmarks[1].uri, bUri("c"));
  assertEquals(r.bookmarks[2].uri, bUri("a"));
});

Deno.test("firstPageBookmarks - merges annotation fields when present", async () => {
  await clearMirrorTables();
  await seedBookmark("d", "2026-05-01T00:00:00.000Z");
  await upsertAnnotation({
    uri: `at://${DID}/app.bookmark.annotation/d`,
    did: DID,
    rkey: "d",
    cid: "bafyA",
    subject: bUri("d"),
    title: "Anno Title",
    note: "anno note",
  });
  const r = await firstPageBookmarks(DID);
  assertEquals(r.bookmarks[0].title, "Anno Title");
  assertEquals(r.bookmarks[0].note, "anno note");
});

Deno.test("firstPageBookmarks - falls back to enriched fields without annotation", async () => {
  await clearMirrorTables();
  await upsertBookmark({
    uri: bUri("e"),
    did: DID,
    rkey: "e",
    cid: "bafyE",
    subject: "https://example.com/e",
    createdAt: "2026-05-01T00:00:00.000Z",
    enrichedTitle: "Enriched Title",
    enrichedFavicon: "https://example.com/favicon.ico",
  });
  const r = await firstPageBookmarks(DID);
  assertEquals(r.bookmarks[0].title, "Enriched Title");
  assertEquals(r.bookmarks[0].favicon, "https://example.com/favicon.ico");
  assertEquals(r.bookmarks[0].note, undefined);
});

Deno.test("firstPageBookmarks - only returns rows for the requested DID", async () => {
  await clearMirrorTables();
  await seedBookmark("a", "2026-05-01T00:00:00.000Z", DID);
  await seedBookmark("a", "2026-05-01T00:00:00.000Z", OTHER_DID);
  const r = await firstPageBookmarks(DID);
  assertEquals(r.bookmarks.length, 1);
  assertEquals(r.bookmarks[0].uri, bUri("a", DID));
});

Deno.test("nextPageBookmarks - paginates stably across boundaries", async () => {
  await clearMirrorTables();
  for (let i = 0; i < 5; i++) {
    await seedBookmark(`r${i}`, `2026-05-0${i + 1}T00:00:00.000Z`);
  }
  const page1 = await firstPageBookmarks(DID, { limit: 2 });
  assertEquals(page1.bookmarks.length, 2);
  assertExists(page1.cursor);
  const page2 = await nextPageBookmarks(DID, page1.cursor!, { limit: 2 });
  assertEquals(page2.bookmarks.length, 2);
  assertExists(page2.cursor);
  const page3 = await nextPageBookmarks(DID, page2.cursor!, { limit: 2 });
  assertEquals(page3.bookmarks.length, 1);
  assertEquals(page3.cursor, undefined);

  const allUris = [
    ...page1.bookmarks,
    ...page2.bookmarks,
    ...page3.bookmarks,
  ].map((b) => b.uri);
  assertEquals(new Set(allUris).size, 5);
});

Deno.test("nextPageBookmarks - tied created_at disambiguated by uri", async () => {
  await clearMirrorTables();
  const ts = "2026-05-01T00:00:00.000Z";
  await seedBookmark("aaa", ts);
  await seedBookmark("bbb", ts);
  await seedBookmark("ccc", ts);
  const page1 = await firstPageBookmarks(DID, { limit: 2 });
  assertEquals(page1.bookmarks.length, 2);
  assertExists(page1.cursor);
  const page2 = await nextPageBookmarks(DID, page1.cursor!, { limit: 2 });
  assertEquals(page2.bookmarks.length, 1);
  const allUris = [...page1.bookmarks, ...page2.bookmarks].map((b) => b.uri);
  assertEquals(new Set(allUris).size, 3);
});

Deno.test("getBookmark - returns null when missing", async () => {
  await clearMirrorTables();
  const b = await getBookmark(bUri("nope"));
  assertEquals(b, null);
});

Deno.test("getBookmark - returns merged annotation + bookmark", async () => {
  await clearMirrorTables();
  await seedBookmark("g", "2026-05-01T00:00:00.000Z");
  await upsertAnnotation({
    uri: `at://${DID}/app.bookmark.annotation/g`,
    did: DID,
    rkey: "g",
    cid: "bafyA",
    subject: bUri("g"),
    note: "saved note",
  });
  const b = await getBookmark(bUri("g"));
  assertExists(b);
  assertEquals(b!.note, "saved note");
});

Deno.test("listTags - returns tags for DID, sorted by value", async () => {
  await clearMirrorTables();
  for (const v of ["zebra", "apple", "mango"]) {
    await upsertTag({
      uri: `at://${DID}/com.kipclip.tag/${v}`,
      did: DID,
      rkey: v,
      cid: `bafy${v}`,
      value: v,
      createdAt: "2026-05-01T00:00:00.000Z",
    });
  }
  await upsertTag({
    uri: `at://${OTHER_DID}/com.kipclip.tag/other`,
    did: OTHER_DID,
    rkey: "other",
    cid: "bafyOther",
    value: "other",
    createdAt: "2026-05-01T00:00:00.000Z",
  });
  const tags = await listTags(DID);
  assertEquals(tags.map((t) => t.value), ["apple", "mango", "zebra"]);
});

Deno.test("getSyncStatus - returns tracking=false for untracked", async () => {
  await clearMirrorTables();
  const s = await getSyncStatus(DID);
  assertEquals(s.tracking, false);
  assertEquals(s.lastSeq, null);
});

Deno.test("getSyncStatus - returns tracked + backfill state", async () => {
  await clearMirrorTables();
  await upsertTrackedDid({
    did: DID,
    pdsUrl: "https://pds.example",
    backfillStartedAt: 1000,
    backfillCompleteAt: 2000,
    lastSeq: 42,
    lastEventAt: 1500,
  });
  const s = await getSyncStatus(DID);
  assertEquals(s.tracking, true);
  assertEquals(s.pdsUrl, "https://pds.example");
  assertEquals(s.backfillStartedAt, 1000);
  assertEquals(s.backfillCompleteAt, 2000);
  assertEquals(s.lastSeq, 42);
  assertEquals(s.lastEventAt, 1500);
});

Deno.test("getSyncStatus - in-progress backfill (started, not complete)", async () => {
  await clearMirrorTables();
  await upsertTrackedDid({ did: DID, backfillStartedAt: 1000 });
  const s = await getSyncStatus(DID);
  assertEquals(s.tracking, true);
  assertEquals(s.backfillStartedAt, 1000);
  assertEquals(s.backfillCompleteAt, null);
});

Deno.test("getMirrorPreferences - returns null when no row", async () => {
  await clearMirrorTables();
  const p = await getMirrorPreferences(DID);
  assertEquals(p, null);
});

Deno.test("getMirrorPreferences - returns parsed object when row exists", async () => {
  await clearMirrorTables();
  await upsertPreferences({
    did: DID,
    cid: "bafyP1",
    dateFormat: "iso",
    readingListTag: "later",
  });
  const p = await getMirrorPreferences(DID);
  assertEquals(p, { dateFormat: "iso", readingListTag: "later" });
});

Deno.test("getMirrorPreferences - returns nulls for missing columns", async () => {
  await clearMirrorTables();
  await upsertPreferences({ did: DID, cid: "bafyP1" });
  const p = await getMirrorPreferences(DID);
  assertEquals(p, { dateFormat: null, readingListTag: null });
});
