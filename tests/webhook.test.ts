/**
 * Regression tests for worker/webhook.ts.
 *
 * Critical invariant: processing a live TAP event for an untracked DID must
 * NOT insert a tracked_dids row. If it did, the mirror gate would open for a
 * DID whose mirror is empty, returning 0 bookmarks instead of falling through
 * to the PDS.
 */

import { assertEquals } from "@std/assert";
import { clearMirrorTables, db } from "./mirror-test-setup.ts";
import { processEvent } from "../worker/webhook.ts";

const DID = "did:plc:webhooktest001";
const RKEY = "abc123";
const _URI = `at://${DID}/community.lexicon.bookmarks.bookmark/${RKEY}`;

async function trackedDidCount(): Promise<number> {
  const r = await db.execute({
    sql: "SELECT COUNT(*) FROM tracked_dids WHERE did = ?",
    args: [DID],
  });
  return Number((r.rows[0] as unknown[])[0]);
}

Deno.test({
  name:
    "live bookmark event for untracked DID does not create tracked_dids row",
  async fn() {
    await clearMirrorTables();

    await processEvent({
      id: 1,
      type: "record",
      record: {
        live: true,
        did: DID,
        collection: "community.lexicon.bookmarks.bookmark",
        rkey: RKEY,
        action: "create",
        record: {
          subject: "https://example.com/test",
          createdAt: "2026-05-09T10:00:00.000Z",
          tags: [],
        },
        cid: "bafytest001",
      },
    });

    assertEquals(
      await trackedDidCount(),
      0,
      "touchTracked must not INSERT a tracked_dids row for an untracked DID",
    );
  },
});

Deno.test({
  name: "live bookmark event for already-tracked DID updates last_event_at",
  async fn() {
    await clearMirrorTables();

    // Insert a properly tracked row (as backfill would create it)
    const before = Date.now() - 5000;
    await db.execute({
      sql:
        `INSERT INTO tracked_dids (did, added_at, backfill_started_at, backfill_complete_at, last_event_at)
            VALUES (?, ?, ?, ?, ?)`,
      args: [DID, before, before, before, before],
    });

    await processEvent({
      id: 2,
      type: "record",
      record: {
        live: true,
        did: DID,
        collection: "community.lexicon.bookmarks.bookmark",
        rkey: RKEY,
        action: "create",
        record: {
          subject: "https://example.com/test2",
          createdAt: "2026-05-09T10:00:00.000Z",
          tags: [],
        },
        cid: "bafytest002",
      },
    });

    const r = await db.execute({
      sql: "SELECT last_event_at FROM tracked_dids WHERE did = ?",
      args: [DID],
    });
    const lastEventAt = Number((r.rows[0] as unknown[])[0]);
    assertEquals(await trackedDidCount(), 1, "still exactly one row");
    assertEquals(
      lastEventAt > before,
      true,
      "last_event_at advanced after live event",
    );
  },
});

Deno.test({
  name: "delete event for untracked DID does not create tracked_dids row",
  async fn() {
    await clearMirrorTables();

    await processEvent({
      id: 3,
      type: "record",
      record: {
        live: true,
        did: DID,
        collection: "community.lexicon.bookmarks.bookmark",
        rkey: RKEY,
        action: "delete",
      },
    });

    assertEquals(
      await trackedDidCount(),
      0,
      "delete on untracked DID must not create tracked_dids row",
    );
  },
});
