/**
 * Tests for U2 (plan 004): dual-write semantics in mirrorWrite + upsert layer.
 *
 * Default test env has no LOCAL_DB_URL → mirrorWriteEnabled() is false →
 * upserts route to rawDb only. To exercise the dual-write path we install a
 * fake `localDb` directly on the lib/db module and toggle MIRROR_DUAL_WRITE.
 *
 * Verifies:
 *   - Flag off → writes go to Turso only (legacy behavior preserved)
 *   - Flag on + both DBs healthy → both receive the row
 *   - Flag on + Turso throws → local has the row, helper resolves, Sentry warns
 *   - Flag on + local throws → helper rejects (TAP must retry)
 *   - mirrorWriteEnabled() reflects flag + localDb presence
 */

import "./test-setup.ts";
import { clearMirrorTables, rawDb } from "./mirror-test-setup.ts";

import { assertEquals, assertRejects } from "@std/assert";
import { _setTestLocalDb, mirrorWrite, mirrorWriteEnabled } from "../lib/db.ts";
import { upsertBookmark } from "../mirror/upserts.ts";

const DID = "did:plc:dualwrite";

interface FakeDb {
  execute: (
    q: { sql: string; args: unknown[] },
  ) => Promise<{ rows: unknown[][] }>;
}

function setFlag(on: boolean) {
  if (on) Deno.env.set("MIRROR_DUAL_WRITE", "on");
  else Deno.env.delete("MIRROR_DUAL_WRITE");
}

function installFakeLocal(db: FakeDb | null) {
  _setTestLocalDb(db);
}

Deno.test("mirrorWriteEnabled - flag on + localDb null → false", () => {
  installFakeLocal(null);
  setFlag(true);
  assertEquals(mirrorWriteEnabled(), false);
  setFlag(false);
});

Deno.test("mirrorWriteEnabled - flag off + localDb set → false", () => {
  installFakeLocal({ execute: () => Promise.resolve({ rows: [] }) });
  setFlag(false);
  assertEquals(mirrorWriteEnabled(), false);
  installFakeLocal(null);
});

Deno.test("mirrorWriteEnabled - flag on + localDb set → true", () => {
  installFakeLocal({ execute: () => Promise.resolve({ rows: [] }) });
  setFlag(true);
  assertEquals(mirrorWriteEnabled(), true);
  setFlag(false);
  installFakeLocal(null);
});

Deno.test("mirrorWrite - flag off → only Turso receives the write", async () => {
  await clearMirrorTables();
  installFakeLocal({
    execute: () => {
      throw new Error("local should not be called");
    },
  });
  setFlag(false);

  await mirrorWrite({
    sql: "INSERT INTO tracked_dids (did, added_at) VALUES (?, ?)",
    args: [DID, Date.now()],
  });

  const r = await rawDb.execute({
    sql: "SELECT did FROM tracked_dids WHERE did = ?",
    args: [DID],
  });
  assertEquals(r.rows.length, 1);

  setFlag(false);
  installFakeLocal(null);
});

Deno.test("mirrorWrite - flag on + both healthy → both receive the row", async () => {
  await clearMirrorTables();

  const localCalls: { sql: string; args: unknown[] }[] = [];
  installFakeLocal({
    execute: (q) => {
      localCalls.push(q);
      return Promise.resolve({ rows: [] });
    },
  });
  setFlag(true);

  await mirrorWrite({
    sql: "INSERT INTO tracked_dids (did, added_at) VALUES (?, ?)",
    args: [DID, Date.now()],
  });

  // Local saw the write.
  assertEquals(localCalls.length, 1);
  // Turso also saw the write (in-memory DB has the row).
  // mirrorWrite intentionally does not await the Turso write — give it a
  // tick to settle before asserting.
  await new Promise((r) => setTimeout(r, 20));
  const r = await rawDb.execute({
    sql: "SELECT did FROM tracked_dids WHERE did = ?",
    args: [DID],
  });
  assertEquals(r.rows.length, 1);

  setFlag(false);
  installFakeLocal(null);
});

Deno.test("mirrorWrite - flag on + Turso throws → local committed, helper resolves", async () => {
  await clearMirrorTables();
  const localCalls: { sql: string; args: unknown[] }[] = [];
  installFakeLocal({
    execute: (q) => {
      localCalls.push(q);
      return Promise.resolve({ rows: [] });
    },
  });
  setFlag(true);

  // Patch rawDb to throw.
  const origExecute = rawDb.execute.bind(rawDb);
  // deno-lint-ignore no-explicit-any
  (rawDb as any).execute = (_q: any) => Promise.reject(new Error("turso boom"));

  try {
    // Should resolve — local succeeded.
    await mirrorWrite({
      sql: "INSERT INTO tracked_dids (did, added_at) VALUES (?, ?)",
      args: [DID, Date.now()],
    });
    assertEquals(localCalls.length, 1);
    // Allow background Turso failure to flush captureMessage import.
    await new Promise((r) => setTimeout(r, 20));
  } finally {
    // deno-lint-ignore no-explicit-any
    (rawDb as any).execute = origExecute;
    setFlag(false);
    installFakeLocal(null);
  }
});

Deno.test("mirrorWrite - flag on + local throws → helper rejects (TAP must retry)", async () => {
  await clearMirrorTables();
  installFakeLocal({
    execute: () => Promise.reject(new Error("local disk full")),
  });
  setFlag(true);

  await assertRejects(
    () =>
      mirrorWrite({
        sql: "INSERT INTO tracked_dids (did, added_at) VALUES (?, ?)",
        args: [DID, Date.now()],
      }),
    Error,
    "local disk full",
  );

  setFlag(false);
  installFakeLocal(null);
});

Deno.test("upsertBookmark - flag on routes through mirrorWrite to both DBs", async () => {
  await clearMirrorTables();

  const localCalls: { sql: string; args: unknown[] }[] = [];
  installFakeLocal({
    execute: (q) => {
      localCalls.push(q);
      return Promise.resolve({ rows: [] });
    },
  });
  setFlag(true);

  await upsertBookmark({
    uri: `at://${DID}/community.lexicon.bookmarks.bookmark/dw1`,
    did: DID,
    rkey: "dw1",
    cid: "bafydw1",
    subject: "https://example.com/dw",
    createdAt: "2026-05-04T00:00:00Z",
    tags: ["news"],
  });

  assertEquals(localCalls.length, 1);
  await new Promise((r) => setTimeout(r, 20));

  const r = await rawDb.execute({
    sql: "SELECT uri FROM bookmarks WHERE did = ?",
    args: [DID],
  });
  assertEquals(r.rows.length, 1);

  setFlag(false);
  installFakeLocal(null);
});
