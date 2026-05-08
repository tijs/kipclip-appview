/**
 * Tests for dual-write semantics in mirrorWrite + upsert layer.
 *
 * Default test env has no TURSO_DATABASE_URL → mirrorWriteEnabled() is false →
 * upserts route to the primary db only. To exercise the dual-write path we
 * install a fake remoteDb directly on the lib/db module via _setTestRemoteDb
 * and toggle MIRROR_DUAL_WRITE.
 *
 * Verifies:
 *   - Flag off → writes go to primary db only
 *   - Flag on + both DBs healthy → both receive the row
 *   - Flag on + remote throws → primary committed, helper resolves, Sentry warns
 *   - Flag on + primary throws → helper rejects (TAP must retry)
 *   - mirrorWriteEnabled() reflects flag + remoteDb presence
 */

import "./test-setup.ts";
import { clearMirrorTables, db } from "./mirror-test-setup.ts";

import { assertEquals, assertRejects } from "@std/assert";
import {
  _setTestRemoteDb,
  mirrorWrite,
  mirrorWriteEnabled,
} from "../lib/db.ts";
import { upsertBookmark } from "../mirror/upserts.ts";

const DID = "did:plc:dualwrite";

interface FakeDb {
  execute: (
    q: { sql: string; args: unknown[] },
  ) => Promise<{ rows: unknown[][]; rowsAffected: number }>;
}

function setFlag(on: boolean) {
  if (on) Deno.env.set("MIRROR_DUAL_WRITE", "on");
  else Deno.env.delete("MIRROR_DUAL_WRITE");
}

function installFakeRemote(fakeDb: FakeDb | null) {
  _setTestRemoteDb(fakeDb);
}

Deno.test("mirrorWriteEnabled - flag on + remoteDb null → false", () => {
  installFakeRemote(null);
  setFlag(true);
  assertEquals(mirrorWriteEnabled(), false);
  setFlag(false);
});

Deno.test("mirrorWriteEnabled - flag off + remoteDb set → false", () => {
  installFakeRemote({
    execute: () => Promise.resolve({ rows: [], rowsAffected: 0 }),
  });
  setFlag(false);
  assertEquals(mirrorWriteEnabled(), false);
  installFakeRemote(null);
});

Deno.test("mirrorWriteEnabled - flag on + remoteDb set → true", () => {
  installFakeRemote({
    execute: () => Promise.resolve({ rows: [], rowsAffected: 0 }),
  });
  setFlag(true);
  assertEquals(mirrorWriteEnabled(), true);
  setFlag(false);
  installFakeRemote(null);
});

Deno.test("mirrorWrite - flag off → only primary db receives the write", async () => {
  await clearMirrorTables();
  installFakeRemote({
    execute: () => {
      throw new Error("remote should not be called");
    },
  });
  setFlag(false);

  await mirrorWrite({
    sql: "INSERT INTO tracked_dids (did, added_at) VALUES (?, ?)",
    args: [DID, Date.now()],
  });

  const r = await db.execute({
    sql: "SELECT did FROM tracked_dids WHERE did = ?",
    args: [DID],
  });
  assertEquals(r.rows.length, 1);

  setFlag(false);
  installFakeRemote(null);
});

Deno.test("mirrorWrite - flag on + both healthy → both receive the row", async () => {
  await clearMirrorTables();

  const remoteCalls: { sql: string; args: unknown[] }[] = [];
  installFakeRemote({
    execute: (q) => {
      remoteCalls.push(q);
      return Promise.resolve({ rows: [], rowsAffected: 0 });
    },
  });
  setFlag(true);

  await mirrorWrite({
    sql: "INSERT INTO tracked_dids (did, added_at) VALUES (?, ?)",
    args: [DID, Date.now()],
  });

  // Remote saw the write.
  assertEquals(remoteCalls.length, 1);
  // Primary db also has the row.
  const r = await db.execute({
    sql: "SELECT did FROM tracked_dids WHERE did = ?",
    args: [DID],
  });
  assertEquals(r.rows.length, 1);

  setFlag(false);
  installFakeRemote(null);
});

Deno.test("mirrorWrite - flag on + remote throws → primary committed, helper resolves", async () => {
  await clearMirrorTables();

  // Install a fake remote that throws.
  installFakeRemote({
    execute: (_q) => Promise.reject(new Error("remote boom")),
  });
  setFlag(true);

  try {
    // Should resolve — primary succeeded.
    await mirrorWrite({
      sql: "INSERT INTO tracked_dids (did, added_at) VALUES (?, ?)",
      args: [DID, Date.now()],
    });
    // Allow background remote failure to flush captureMessage import.
    await new Promise((r) => setTimeout(r, 20));

    // Primary has the row.
    const r = await db.execute({
      sql: "SELECT did FROM tracked_dids WHERE did = ?",
      args: [DID],
    });
    assertEquals(r.rows.length, 1);
  } finally {
    setFlag(false);
    installFakeRemote(null);
  }
});

Deno.test("mirrorWrite - flag on + primary throws → helper rejects (TAP must retry)", async () => {
  await clearMirrorTables();
  installFakeRemote({
    execute: () => Promise.resolve({ rows: [], rowsAffected: 0 }),
  });
  setFlag(true);

  // Patch the primary db.execute to throw.
  const origExecute = db.execute.bind(db);
  // deno-lint-ignore no-explicit-any
  (db as any).execute = (_q: any) =>
    Promise.reject(new Error("primary disk full"));

  try {
    await assertRejects(
      () =>
        mirrorWrite({
          sql: "INSERT INTO tracked_dids (did, added_at) VALUES (?, ?)",
          args: [DID, Date.now()],
        }),
      Error,
      "primary disk full",
    );
  } finally {
    // deno-lint-ignore no-explicit-any
    (db as any).execute = origExecute;
    setFlag(false);
    installFakeRemote(null);
  }
});

Deno.test("upsertBookmark - flag on routes through mirrorWrite to both DBs", async () => {
  await clearMirrorTables();

  const remoteCalls: { sql: string; args: unknown[] }[] = [];
  installFakeRemote({
    execute: (q) => {
      remoteCalls.push(q);
      return Promise.resolve({ rows: [], rowsAffected: 0 });
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

  assertEquals(remoteCalls.length, 1);
  await new Promise((r) => setTimeout(r, 20));

  const r = await db.execute({
    sql: "SELECT uri FROM bookmarks WHERE did = ?",
    args: [DID],
  });
  assertEquals(r.rows.length, 1);

  setFlag(false);
  installFakeRemote(null);
});
