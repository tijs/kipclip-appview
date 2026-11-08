import "../runtime/deno/install.ts";
/**
 * Tests for lib/reconcile.ts — PDS-authoritative mirror repair.
 *
 * Pins:
 *   - Stale rows (in mirror, gone from PDS) are deleted; live-but-missing
 *     rows are upserted. This is the bidirectional repair the webhook path
 *     and the upsert-only backfill can't do (the vicwalker.dev.br case).
 *   - A PDS fetch failure aborts BEFORE any delete — a transient error or
 *     wrong host can never wipe a mirror.
 *   - --dry-run reports the would-delete count without touching the mirror.
 *   - Annotations union both collections (com.kipclip + legacy app.bookmark)
 *     so a legacy annotation isn't deleted as "missing".
 *   - Preferences (one row per DID, no URI) are deleted only when the PDS
 *     holds none.
 */

import "./test-setup.ts";
import { clearMirrorTables, db } from "./mirror-test-setup.ts";
import { assertEquals, assertRejects } from "@std/assert";

import { reconcileDid } from "../lib/reconcile.ts";
import {
  deleteBookmark,
  upsertAnnotation,
  upsertBookmark,
  upsertPreferences,
} from "../mirror/upserts.ts";

const DID = "did:plc:recon123";
const PDS = "https://pds.example.test";

// deno-lint-ignore no-explicit-any
type Rec = any;

function bookmarkRec(rkey: string): Rec {
  return {
    uri: `at://${DID}/community.lexicon.bookmarks.bookmark/${rkey}`,
    cid: `cid-${rkey}`,
    value: {
      subject: `https://example.com/${rkey}`,
      createdAt: "2026-01-01T00:00:00.000Z",
      tags: [],
    },
  };
}

function annotationRec(collection: string, rkey: string): Rec {
  return {
    uri: `at://${DID}/${collection}/${rkey}`,
    cid: `cid-${rkey}`,
    value: { subject: `https://example.com/${rkey}`, title: rkey },
  };
}

/** Stub fetch to answer listRecords per collection. `failCollection` returns
 * 503 for that one collection to exercise the abort-before-delete path. */
function installPdsStub(
  byCollection: Record<string, Rec[]>,
  failCollection?: string,
): { restore: () => void } {
  const original = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input.toString();
    const collection = new URL(url).searchParams.get("collection") ?? "";
    if (collection === failCollection) {
      return Promise.resolve(new Response("PDS unavailable", { status: 503 }));
    }
    const records = byCollection[collection] ?? [];
    return Promise.resolve(
      new Response(JSON.stringify({ records }), { status: 200 }),
    );
  }) as typeof globalThis.fetch;
  return {
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

async function seedBookmark(rkey: string): Promise<void> {
  await upsertBookmark({
    uri: `at://${DID}/community.lexicon.bookmarks.bookmark/${rkey}`,
    did: DID,
    rkey,
    cid: `seed-${rkey}`,
    subject: `https://example.com/${rkey}`,
    createdAt: "2026-01-01T00:00:00.000Z",
    tags: [],
  });
}

async function mirrorRkeys(table: string): Promise<string[]> {
  const res = await db.execute({
    sql: `SELECT rkey FROM ${table} WHERE did = ? ORDER BY rkey`,
    args: [DID],
  });
  return res.rows.map((r) => String(r[0]));
}

Deno.test("reconcile deletes stale rows and adds missing ones", async () => {
  await clearMirrorTables();
  // Mirror starts with A, B, C (B and C were deleted on the PDS since backfill).
  await seedBookmark("A");
  await seedBookmark("B");
  await seedBookmark("C");

  // PDS now holds only A plus a new D created after backfill.
  const stub = installPdsStub({
    "community.lexicon.bookmarks.bookmark": [
      bookmarkRec("A"),
      bookmarkRec("D"),
    ],
  });
  try {
    const res = await reconcileDid(DID, PDS);
    assertEquals(res.deleted.bookmarks, 2); // B, C removed
    assertEquals(res.live.bookmarks, 2); // A, D
  } finally {
    stub.restore();
  }

  assertEquals(await mirrorRkeys("bookmarks"), ["A", "D"]);
});

Deno.test("reconcile aborts before any delete when the PDS fetch fails", async () => {
  await clearMirrorTables();
  await seedBookmark("A");
  await seedBookmark("B");

  // listRecords for bookmarks 503s — fetchLiveRepo throws, no delete runs.
  const stub = installPdsStub({}, "community.lexicon.bookmarks.bookmark");
  try {
    await assertRejects(() => reconcileDid(DID, PDS));
  } finally {
    stub.restore();
  }

  // Mirror is untouched — the safety property that prevents a wipe.
  assertEquals(await mirrorRkeys("bookmarks"), ["A", "B"]);
});

Deno.test("reconcile --dry-run reports deletions without writing", async () => {
  await clearMirrorTables();
  await seedBookmark("A");
  await seedBookmark("B");

  const stub = installPdsStub({
    "community.lexicon.bookmarks.bookmark": [bookmarkRec("A")],
  });
  try {
    const res = await reconcileDid(DID, PDS, { dryRun: true });
    assertEquals(res.dryRun, true);
    assertEquals(res.deleted.bookmarks, 1); // B would be removed
  } finally {
    stub.restore();
  }

  // Nothing actually deleted.
  assertEquals(await mirrorRkeys("bookmarks"), ["A", "B"]);
});

Deno.test("reconcile unions both annotation collections before deleting", async () => {
  await clearMirrorTables();
  // Mirror holds a kipclip annotation, a legacy annotation, and a stale one.
  await upsertAnnotation({
    uri: `at://${DID}/com.kipclip.annotation/k1`,
    did: DID,
    rkey: "k1",
    cid: "seed-k1",
    subject: "https://example.com/k1",
  });
  await upsertAnnotation({
    uri: `at://${DID}/app.bookmark.annotation/l1`,
    did: DID,
    rkey: "l1",
    cid: "seed-l1",
    subject: "https://example.com/l1",
  });
  await upsertAnnotation({
    uri: `at://${DID}/com.kipclip.annotation/stale`,
    did: DID,
    rkey: "stale",
    cid: "seed-stale",
    subject: "https://example.com/stale",
  });

  // PDS still holds k1 (kipclip) and l1 (legacy) — only `stale` is gone.
  const stub = installPdsStub({
    "com.kipclip.annotation": [annotationRec("com.kipclip.annotation", "k1")],
    "app.bookmark.annotation": [
      annotationRec("app.bookmark.annotation", "l1"),
    ],
  });
  try {
    const res = await reconcileDid(DID, PDS);
    assertEquals(res.deleted.annotations, 1); // only `stale`
  } finally {
    stub.restore();
  }

  assertEquals(await mirrorRkeys("annotations"), ["k1", "l1"]);
});

Deno.test("reconcile deletes preferences only when the PDS holds none", async () => {
  await clearMirrorTables();
  await upsertPreferences({ did: DID, cid: "seed-pref", dateFormat: "iso" });

  const stub = installPdsStub({}); // no preferences on PDS
  try {
    const res = await reconcileDid(DID, PDS);
    assertEquals(res.deleted.preferences, 1);
  } finally {
    stub.restore();
  }

  const remaining = await db.execute({
    sql: "SELECT COUNT(*) FROM preferences WHERE did = ?",
    args: [DID],
  });
  assertEquals(Number(remaining.rows[0][0]), 0);
});

for (const mutation of ["create", "update", "delete"] as const) {
  Deno.test(`reconciliation rejects a stale snapshot after concurrent ${mutation}`, async () => {
    await clearMirrorTables();
    if (mutation !== "create") await seedBookmark("concurrent");
    const original = globalThis.fetch;
    let release!: () => void;
    let captured!: () => void;
    const blocked = new Promise<void>((r) => release = r);
    const snapshotRead = new Promise<void>((r) => captured = r);
    globalThis.fetch = (async (input: string | URL | Request) => {
      const collection = new URL(String(input)).searchParams.get("collection");
      if (collection === "com.kipclip.preferences") {
        captured();
        await blocked;
      }
      return Response.json({
        records: collection === "community.lexicon.bookmarks.bookmark" &&
            mutation !== "create"
          ? [bookmarkRec("concurrent")]
          : [],
      });
    }) as typeof fetch;
    try {
      const pending = reconcileDid(DID, PDS);
      await snapshotRead;
      if (mutation === "delete") {
        await deleteBookmark(bookmarkRec("concurrent").uri, DID);
      } else if (mutation === "create") await seedBookmark("concurrent");
      // Use a raw SQL writer as well: the fence is database-visible, not a
      // process-local flag or a convention restricted to upsert helpers.
      if (mutation === "update") {
        await db.execute({
          sql:
            "UPDATE bookmarks SET subject = 'https://new.example' WHERE did = ?",
          args: [DID],
        });
      }
      release();
      await assertRejects(() => pending, Error, "Mirror changed");
      assertEquals(
        await mirrorRkeys("bookmarks"),
        mutation === "delete" ? [] : ["concurrent"],
      );
      const events = await db.execute({
        sql: "SELECT COUNT(*) FROM app_events WHERE did = ?",
        args: [DID],
      });
      assertEquals(Number(events.rows[0][0]), mutation === "delete" ? 0 : 1);
      if (mutation === "update") {
        const row = await db.execute({
          sql: "SELECT subject FROM bookmarks WHERE did = ?",
          args: [DID],
        });
        assertEquals(row.rows[0][0], "https://new.example");
      }
    } finally {
      release();
      globalThis.fetch = original;
    }
  });
}

for (const table of ["annotations", "tags", "preferences"] as const) {
  Deno.test(`raw ${table} writer invalidates an in-flight reconciliation snapshot`, async () => {
    await clearMirrorTables();
    const original = globalThis.fetch;
    let release!: () => void, captured!: () => void;
    const blocked = new Promise<void>((r) => release = r),
      ready = new Promise<void>((r) => captured = r);
    globalThis.fetch = (async (input: string | URL | Request) => {
      if (
        new URL(String(input)).searchParams.get("collection") ===
          "com.kipclip.preferences"
      ) {
        captured();
        await blocked;
      }
      return Response.json({ records: [] });
    }) as typeof fetch;
    try {
      const pending = reconcileDid(DID, PDS);
      await ready;
      const sql = table === "preferences"
        ? "INSERT INTO preferences (did,cid,updated_at) VALUES (?, 'new', 0)"
        : table === "tags"
        ? "INSERT INTO tags (did,uri,rkey,cid,value,created_at,updated_at) VALUES (?, 'at://raw/tag', 'raw', 'new', 'raw', '', 0)"
        : "INSERT INTO annotations (did,uri,rkey,cid,subject,updated_at) VALUES (?, 'at://raw/annotation', 'raw', 'new', 'at://raw/bookmark', 0)";
      await db.execute({ sql, args: [DID] });
      release();
      await assertRejects(() => pending, Error, "Mirror changed");
      assertEquals(
        (await db.execute({
          sql: `SELECT COUNT(*) FROM ${table} WHERE did = ?`,
          args: [DID],
        })).rows[0][0],
        1,
      );
    } finally {
      release();
      globalThis.fetch = original;
    }
  });
}
