import "../runtime/deno/install.ts";
import "./test-setup.ts";
import { assertEquals, assertRejects } from "@std/assert";
import { clearMirrorTables, db } from "./mirror-test-setup.ts";
import { auditTrackedDrift } from "../lib/drift-audit.ts";
import { reconcileCurrentDid } from "../lib/reconcile.ts";
import { upsertBookmark } from "../mirror/upserts.ts";

const DID = "did:plc:migrated200";
const OLD = "https://old.example.test";
const CURRENT = "https://current.example.test";

async function fixture(
  fn: (calls: string[]) => Promise<void>,
  opts: { resolveFailure?: boolean; collectionFailure?: boolean } = {},
) {
  await clearMirrorTables();
  await db.execute({
    sql: "INSERT INTO tracked_dids (did, pds_url, added_at) VALUES (?, ?, ?)",
    args: [DID, OLD, Date.now()],
  });
  const uri = `at://${DID}/community.lexicon.bookmarks.bookmark/old`;
  await upsertBookmark({
    uri,
    did: DID,
    rkey: "old",
    cid: "old-cid",
    subject: "https://example.com/old",
    createdAt: "2026-01-01T00:00:00Z",
    tags: [],
  });
  const original = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = ((input) => {
    const url = String(input);
    calls.push(url);
    if (url.startsWith("https://plc.directory/")) {
      return Promise.resolve(
        opts.resolveFailure
          ? new Response("unavailable", { status: 503 })
          : Response.json({
            service: [{ id: "#atproto_pds", serviceEndpoint: CURRENT }],
          }),
      );
    }
    if (url.startsWith(OLD)) {
      // The dangerous case: obsolete host still returns a successful old repo.
      return Promise.resolve(
        Response.json({ records: [{ uri, cid: "old-cid" }] }),
      );
    }
    if (url.startsWith(CURRENT)) {
      return Promise.resolve(
        opts.collectionFailure
          ? new Response("unavailable", { status: 503 })
          : Response.json({ records: [] }),
      );
    }
    throw new Error(`Unexpected request ${url}`);
  }) as typeof fetch;
  try {
    await fn(calls);
  } finally {
    globalThis.fetch = original;
    await clearMirrorTables();
  }
}

async function snapshot() {
  return {
    host: (await db.execute({
      sql: "SELECT pds_url FROM tracked_dids WHERE did=?",
      args: [DID],
    })).rows[0][0],
    bookmarks: Number(
      (await db.execute({
        sql: "SELECT COUNT(*) FROM bookmarks WHERE did=?",
        args: [DID],
      })).rows[0][0],
    ),
    state: (await db.execute({ sql: "SELECT * FROM tap_repo_state", args: [] }))
      .rows,
    missing:
      (await db.execute({ sql: "SELECT * FROM missing_repos", args: [] })).rows,
  };
}

Deno.test("audit detects successful stale PDS and classifies current empty repo as mirror-ahead", async () => {
  await fixture(async (calls) => {
    const result = await auditTrackedDrift();
    assertEquals(result.ahead.length, 1);
    assertEquals(result.ahead[0].pds, 0);
    assertEquals(result.ahead[0].pdsMigrated, { from: OLD, to: CURRENT });
    assertEquals((await snapshot()).host, CURRENT);
    assertEquals(calls.some((url) => url.startsWith(OLD)), false);
  });
});

Deno.test("reconcile uses current authority even when old PDS still answers 200", async () => {
  await fixture(async (calls) => {
    const result = await reconcileCurrentDid(DID);
    assertEquals(result.deleted.bookmarks, 1);
    assertEquals((await snapshot()).bookmarks, 0);
    assertEquals((await snapshot()).host, CURRENT);
    assertEquals(calls.some((url) => url.startsWith(OLD)), false);
  });
});

Deno.test("dry-run migration audit and reconcile do not mutate host, rows or bookkeeping", async () => {
  await fixture(async () => {
    const before = await snapshot();
    assertEquals(
      (await auditTrackedDrift(undefined, { persist: false })).ahead.length,
      1,
    );
    assertEquals(
      (await reconcileCurrentDid(DID, { dryRun: true })).deleted.bookmarks,
      1,
    );
    assertEquals(await snapshot(), before);
  });
});

for (const failure of ["resolveFailure", "collectionFailure"] as const) {
  Deno.test(`reconcile aborts without deleting or changing host on ${failure}`, async () => {
    await fixture(async (calls) => {
      const before = await snapshot();
      await assertRejects(() => reconcileCurrentDid(DID));
      assertEquals(await snapshot(), before);
      assertEquals(calls.some((url) => url.startsWith(OLD)), false);
      const audit = await auditTrackedDrift(undefined, { persist: false });
      assertEquals(audit.errors.length, 1);
      assertEquals(await snapshot(), before);
      if (failure === "resolveFailure") {
        assertEquals(calls.some((url) => url.startsWith(CURRENT)), false);
        assertEquals(audit.errors[0].pdsErrorClass, "resolve-failed");
      }
    }, { [failure]: true });
  });
}
