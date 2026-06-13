/**
 * Tests for lib/forwarding-audit.ts — mirror-vs-TAP forwarding-drift detection.
 *
 * Pins:
 *   - Matching counts are not flagged; a mismatch with an empty outbox is.
 *   - A mismatch with a non-empty TAP outbox is NOT flagged (forward in flight).
 *   - Non-tracked collections in TAP's repo_records don't count toward the
 *     comparison (only the collections TAP forwards to us do).
 *   - auditForwardingDrift fails open (skipped:true) when tap.db is unreadable,
 *     so it can never break drift-alert.
 */

import "./test-setup.ts";
import { clearMirrorTables, db } from "./mirror-test-setup.ts";
import { assertEquals } from "@std/assert";

import {
  auditForwardingDrift,
  flagForwardingDrift,
} from "../lib/forwarding-audit.ts";
import { upsertBookmark } from "../mirror/upserts.ts";

Deno.test("flagForwardingDrift: match not flagged, empty-outbox mismatch flagged", () => {
  const flagged = flagForwardingDrift([
    { did: "did:plc:a", mirror: 5, tap: 5, outbox: 0 }, // match
    { did: "did:plc:b", mirror: 2, tap: 7, outbox: 0 }, // mismatch, idle
    { did: "did:plc:c", mirror: 2, tap: 7, outbox: 3 }, // mismatch, in flight
  ]);
  assertEquals(flagged.map((r) => r.did), ["did:plc:b"]);
});

Deno.test("flagForwardingDrift: respects minDiff threshold", () => {
  const rows = [{ did: "did:plc:a", mirror: 4, tap: 5, outbox: 0 }];
  assertEquals(flagForwardingDrift(rows, 1).length, 1);
  assertEquals(flagForwardingDrift(rows, 2).length, 0);
});

Deno.test("auditForwardingDrift: skips (fails open) when tap.db is unreadable", async () => {
  await clearMirrorTables();
  // A tracked DID must exist or the audit short-circuits before tap.db.
  await db.execute({
    sql: "INSERT INTO tracked_dids (did, pds_url, added_at) VALUES (?, ?, ?)",
    args: ["did:plc:x", "https://pds.test", 1],
  });
  const res = await auditForwardingDrift({
    tapDbPath: "/nonexistent/does/not/exist.db",
  });
  assertEquals(res.skipped, true);
  assertEquals(res.flagged.length, 0);
});

Deno.test("auditForwardingDrift: flags mirror-vs-TAP divergence end to end", async () => {
  await clearMirrorTables();
  const BOOKMARK = "community.lexicon.bookmarks.bookmark";

  // Mirror: A has 2 bookmarks (will match TAP), B has 1 (will diverge).
  for (const [did, n] of [["did:plc:a", 2], ["did:plc:b", 1]] as const) {
    await db.execute({
      sql: "INSERT INTO tracked_dids (did, pds_url, added_at) VALUES (?, ?, ?)",
      args: [did, "https://pds.test", 1],
    });
    for (let i = 0; i < n; i++) {
      await upsertBookmark({
        uri: `at://${did}/${BOOKMARK}/r${i}`,
        did,
        rkey: `r${i}`,
        cid: `c${i}`,
        subject: `https://example.com/${did}/${i}`,
        createdAt: "2026-01-01T00:00:00.000Z",
        tags: [],
      });
    }
  }

  // Build a temp tap.db: A has 2 tracked records (match); B has 4 tracked + 1
  // non-tracked post (so B's tracked total is 4, diverging from mirror's 1).
  const tmp = await Deno.makeTempFile({ suffix: ".db" });
  const { createClient } = await import("@libsql/client");
  const tap = createClient({ url: `file:${tmp}` });
  try {
    await tap.execute(
      "CREATE TABLE repo_records (did TEXT, collection TEXT, rkey TEXT, cid TEXT NOT NULL, PRIMARY KEY (did, collection, rkey))",
    );
    await tap.execute(
      "CREATE TABLE outbox_buffers (id INTEGER PRIMARY KEY AUTOINCREMENT, did TEXT NOT NULL, live NUMERIC NOT NULL, data TEXT NOT NULL)",
    );
    const recs: Array<[string, string, string]> = [
      ["did:plc:a", BOOKMARK, "r0"],
      ["did:plc:a", BOOKMARK, "r1"],
      ["did:plc:b", BOOKMARK, "r0"],
      ["did:plc:b", BOOKMARK, "r1"],
      ["did:plc:b", BOOKMARK, "r2"],
      ["did:plc:b", BOOKMARK, "r3"],
      ["did:plc:b", "app.bsky.feed.post", "p0"], // non-tracked, must not count
    ];
    for (const [did, collection, rkey] of recs) {
      await tap.execute({
        sql:
          "INSERT INTO repo_records (did, collection, rkey, cid) VALUES (?, ?, ?, ?)",
        args: [did, collection, rkey, `cid-${rkey}`],
      });
    }
    tap.close();

    const res = await auditForwardingDrift({ tapDbPath: tmp });
    assertEquals(res.skipped, false);
    assertEquals(res.checked, 2);
    // Only B diverges (mirror 1 vs TAP tracked 4); A matches (2 vs 2).
    assertEquals(res.flagged.map((r) => r.did), ["did:plc:b"]);
    assertEquals(res.flagged[0].mirror, 1);
    assertEquals(res.flagged[0].tap, 4); // post excluded
  } finally {
    await Deno.remove(tmp).catch(() => {});
    await Deno.remove(`${tmp}-wal`).catch(() => {});
    await Deno.remove(`${tmp}-shm`).catch(() => {});
  }
});
