/**
 * Tests for fetchOwnerBookmarkRecords + fetchOwnerTagRecords (U1, plan 003).
 *
 * Covers mirror-vs-PDS branching, mirror authority on empty result,
 * Turso-failure fallback path, and forcePds override.
 */

import "./test-setup.ts";
import { clearMirrorTables, rawDb } from "./mirror-test-setup.ts";

import { assertEquals } from "@std/assert";
import { _resetMirrorModeCache } from "../lib/mirror-config.ts";
import {
  fetchOwnerBookmarkRecords,
  fetchOwnerTagRecords,
} from "../lib/route-utils.ts";
import {
  upsertBookmark,
  upsertTag,
  upsertTrackedDid,
} from "../mirror/upserts.ts";
import { createMockSession } from "./test-helpers.ts";
import { listRecordsResponse } from "./test-helpers.ts";

const DID = "did:plc:helpers";
const OTHER = "did:plc:other";

function setMode(mode: "off" | "read") {
  Deno.env.set("MIRROR_MODE", mode);
  _resetMirrorModeCache();
}

async function seedTracked() {
  await upsertTrackedDid({
    did: DID,
    backfillStartedAt: 1,
    backfillCompleteAt: 2,
  });
}

async function seedBookmark(rkey: string) {
  await upsertBookmark({
    uri: `at://${DID}/community.lexicon.bookmarks.bookmark/${rkey}`,
    did: DID,
    rkey,
    cid: `bafy${rkey}`,
    subject: `https://example.com/${rkey}`,
    createdAt: "2026-05-04T00:00:00Z",
    tags: ["news"],
  });
}

async function seedTag(rkey: string, value: string) {
  await upsertTag({
    uri: `at://${DID}/com.kipclip.tag/${rkey}`,
    did: DID,
    rkey,
    cid: `tag${rkey}`,
    value,
    createdAt: "2026-05-04T00:00:00Z",
  });
}

Deno.test("fetchOwnerBookmarkRecords - tracked + mirror populated → returns mirror records in PDS shape", async () => {
  await clearMirrorTables();
  setMode("read");
  await seedTracked();
  await seedBookmark("a");
  await seedBookmark("b");

  const session = createMockSession({ did: DID });
  // PDS path would 200 with the default response — if it leaks through,
  // assertion below would still match because mirror has 2, default has none.
  const records = await fetchOwnerBookmarkRecords(session);

  assertEquals(records.length, 2);
  const r0 = records[0];
  assertEquals(typeof r0.uri, "string");
  assertEquals(typeof r0.cid, "string");
  assertEquals(typeof r0.value.subject, "string");
  assertEquals(Array.isArray(r0.value.tags), true);
  setMode("off");
});

Deno.test("fetchOwnerBookmarkRecords - untracked DID → falls through to PDS", async () => {
  await clearMirrorTables();
  setMode("read");
  // No tracked_dids row.

  const session = createMockSession({
    did: DID,
    defaultPdsResponse: listRecordsResponse([
      {
        uri: `at://${DID}/community.lexicon.bookmarks.bookmark/x`,
        cid: "bafyx",
        value: {
          subject: "https://example.com/x",
          createdAt: "2026",
          tags: [],
        },
      },
    ]),
  });

  const records = await fetchOwnerBookmarkRecords(session);
  assertEquals(records.length, 1);
  assertEquals(records[0].cid, "bafyx");
  setMode("off");
});

Deno.test("fetchOwnerBookmarkRecords - tracked + empty mirror → returns [] (mirror authoritative, no PDS fallback)", async () => {
  await clearMirrorTables();
  setMode("read");
  await seedTracked();
  // Mirror is empty for DID.

  // PDS would return one record if accidentally consulted.
  const session = createMockSession({
    did: DID,
    defaultPdsResponse: listRecordsResponse([
      {
        uri: `at://${DID}/community.lexicon.bookmarks.bookmark/leak`,
        cid: "leak",
        value: { subject: "https://leak.example", createdAt: "2026", tags: [] },
      },
    ]),
  });

  const records = await fetchOwnerBookmarkRecords(session);
  assertEquals(records, []); // would be [{cid: "leak", ...}] if PDS leaked through
  setMode("off");
});

Deno.test("fetchOwnerBookmarkRecords - mirror Turso throws → falls back to PDS", async () => {
  await clearMirrorTables();
  setMode("read");
  await seedTracked();
  await seedBookmark("a");

  // Force Turso failure by closing connection: easiest way is to dynamically
  // monkey-patch rawDb.execute. The helper catches and falls back to PDS.
  const orig = rawDb.execute.bind(rawDb);
  let calls = 0;
  // Throw only on the bookmark SELECT, not on getSyncStatus or migrations.
  // deno-lint-ignore no-explicit-any
  (rawDb as any).execute = (q: any) => {
    if (typeof q?.sql === "string" && q.sql.includes("FROM bookmarks b")) {
      calls++;
      throw new Error("turso boom");
    }
    return orig(q);
  };

  try {
    const session = createMockSession({
      did: DID,
      defaultPdsResponse: listRecordsResponse([
        {
          uri: `at://${DID}/community.lexicon.bookmarks.bookmark/pds`,
          cid: "pds",
          value: {
            subject: "https://pds.example",
            createdAt: "2026",
            tags: [],
          },
        },
      ]),
    });
    const records = await fetchOwnerBookmarkRecords(session);
    assertEquals(records.length, 1);
    assertEquals(records[0].cid, "pds");
    assertEquals(calls, 1);
  } finally {
    // deno-lint-ignore no-explicit-any
    (rawDb as any).execute = orig;
    setMode("off");
  }
});

Deno.test("fetchOwnerBookmarkRecords - MIRROR_MODE=off → PDS unconditionally", async () => {
  await clearMirrorTables();
  setMode("off");
  await seedTracked();
  await seedBookmark("a"); // mirror has data; should be ignored

  const session = createMockSession({
    did: DID,
    defaultPdsResponse: listRecordsResponse([
      {
        uri: `at://${DID}/community.lexicon.bookmarks.bookmark/p`,
        cid: "p",
        value: { subject: "https://p.example", createdAt: "2026", tags: [] },
      },
    ]),
  });

  const records = await fetchOwnerBookmarkRecords(session);
  assertEquals(records.length, 1);
  assertEquals(records[0].cid, "p"); // PDS, not mirror
});

Deno.test("fetchOwnerBookmarkRecords - forcePds bypasses mirror even when tracked", async () => {
  await clearMirrorTables();
  setMode("read");
  await seedTracked();
  await seedBookmark("mirror-only");

  const session = createMockSession({
    did: DID,
    defaultPdsResponse: listRecordsResponse([
      {
        uri: `at://${DID}/community.lexicon.bookmarks.bookmark/from-pds`,
        cid: "from-pds",
        value: {
          subject: "https://from-pds.example",
          createdAt: "2026",
          tags: [],
        },
      },
    ]),
  });

  const records = await fetchOwnerBookmarkRecords(session, { forcePds: true });
  assertEquals(records.length, 1);
  assertEquals(records[0].cid, "from-pds");
  setMode("off");
});

Deno.test("fetchOwnerBookmarkRecords - cross-DID isolation: returns only owner's rows", async () => {
  await clearMirrorTables();
  setMode("read");
  await seedTracked();
  await seedBookmark("mine");
  // Seed another DID's bookmark — must not appear.
  await upsertBookmark({
    uri: `at://${OTHER}/community.lexicon.bookmarks.bookmark/theirs`,
    did: OTHER,
    rkey: "theirs",
    cid: "theirs",
    subject: "https://theirs.example",
    createdAt: "2026-05-04T00:00:00Z",
    tags: [],
  });

  const session = createMockSession({ did: DID });
  const records = await fetchOwnerBookmarkRecords(session);
  assertEquals(records.length, 1);
  assertEquals(records[0].uri.includes(DID), true);
  setMode("off");
});

Deno.test("fetchOwnerTagRecords - tracked + mirror populated → mirror records in PDS shape", async () => {
  await clearMirrorTables();
  setMode("read");
  await seedTracked();
  await seedTag("t1", "Rust");
  await seedTag("t2", "Swift");

  const session = createMockSession({ did: DID });
  const records = await fetchOwnerTagRecords(session);
  assertEquals(records.length, 2);
  const r0 = records[0];
  assertEquals(typeof r0.uri, "string");
  assertEquals(typeof r0.cid, "string");
  assertEquals(typeof r0.value.value, "string");
  setMode("off");
});

Deno.test("fetchOwnerTagRecords - untracked DID → PDS fallback", async () => {
  await clearMirrorTables();
  setMode("read");

  const session = createMockSession({
    did: DID,
    defaultPdsResponse: listRecordsResponse([
      {
        uri: `at://${DID}/com.kipclip.tag/x`,
        cid: "tx",
        value: { value: "PDSOnly", createdAt: "2026" },
      },
    ]),
  });
  const records = await fetchOwnerTagRecords(session);
  assertEquals(records.length, 1);
  assertEquals(records[0].value.value, "PDSOnly");
  setMode("off");
});

Deno.test("fetchOwnerTagRecords - tracked + mirror empty → [] (no PDS leak)", async () => {
  await clearMirrorTables();
  setMode("read");
  await seedTracked();

  const session = createMockSession({
    did: DID,
    defaultPdsResponse: listRecordsResponse([
      {
        uri: `at://${DID}/com.kipclip.tag/leak`,
        cid: "leak",
        value: { value: "leak", createdAt: "2026" },
      },
    ]),
  });
  const records = await fetchOwnerTagRecords(session);
  assertEquals(records, []);
  setMode("off");
});

Deno.test("fetchOwnerTagRecords - Turso throws → PDS fallback", async () => {
  await clearMirrorTables();
  setMode("read");
  await seedTracked();
  await seedTag("t1", "Rust");

  const orig = rawDb.execute.bind(rawDb);
  let calls = 0;
  // deno-lint-ignore no-explicit-any
  (rawDb as any).execute = (q: any) => {
    if (typeof q?.sql === "string" && q.sql.includes("FROM tags WHERE did")) {
      calls++;
      throw new Error("turso boom");
    }
    return orig(q);
  };
  try {
    const session = createMockSession({
      did: DID,
      defaultPdsResponse: listRecordsResponse([
        {
          uri: `at://${DID}/com.kipclip.tag/p`,
          cid: "p",
          value: { value: "FromPds", createdAt: "2026" },
        },
      ]),
    });
    const records = await fetchOwnerTagRecords(session);
    assertEquals(records.length, 1);
    assertEquals(records[0].value.value, "FromPds");
    assertEquals(calls, 1);
  } finally {
    // deno-lint-ignore no-explicit-any
    (rawDb as any).execute = orig;
    setMode("off");
  }
});

Deno.test("fetchOwnerTagRecords - forcePds bypasses mirror", async () => {
  await clearMirrorTables();
  setMode("read");
  await seedTracked();
  await seedTag("t1", "MirrorOnly");

  const session = createMockSession({
    did: DID,
    defaultPdsResponse: listRecordsResponse([
      {
        uri: `at://${DID}/com.kipclip.tag/fp`,
        cid: "fp",
        value: { value: "FromPds", createdAt: "2026" },
      },
    ]),
  });
  const records = await fetchOwnerTagRecords(session, { forcePds: true });
  assertEquals(records.length, 1);
  assertEquals(records[0].value.value, "FromPds");
  setMode("off");
});
