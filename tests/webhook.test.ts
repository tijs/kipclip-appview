/**
 * Regression tests for worker/webhook.ts.
 *
 * Critical invariants:
 * 1. Processing a live TAP event for an untracked DID must NOT insert a
 *    tracked_dids row. If it did, the mirror gate would open for a DID whose
 *    mirror is empty, returning 0 bookmarks instead of falling through to PDS.
 * 2. A live event for an enrolled DID must stamp backfill_complete_at (once,
 *    idempotently) so the DID doesn't remain in "syncing" state forever.
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

// --- Negative assertions for all collection types ---

const untrackedTests: Array<
  { name: string; id: number; evt: Parameters<typeof processEvent>[0] }
> = [
  {
    name: "annotation (legacy) create",
    id: 10,
    evt: {
      id: 10,
      type: "record",
      record: {
        live: true,
        did: DID,
        collection: "app.bookmark.annotation",
        rkey: RKEY,
        action: "create",
        record: { subject: "https://example.com/anno", title: "T" },
        cid: "bafyanno001",
      },
    },
  },
  {
    name: "annotation (legacy) delete",
    id: 11,
    evt: {
      id: 11,
      type: "record",
      record: {
        live: true,
        did: DID,
        collection: "app.bookmark.annotation",
        rkey: RKEY,
        action: "delete",
      },
    },
  },
  {
    name: "com.kipclip.annotation create",
    id: 12,
    evt: {
      id: 12,
      type: "record",
      record: {
        live: true,
        did: DID,
        collection: "com.kipclip.annotation",
        rkey: RKEY,
        action: "create",
        record: { subject: "https://example.com/kipanno" },
        cid: "bafykipanno",
      },
    },
  },
  {
    name: "tag create",
    id: 13,
    evt: {
      id: 13,
      type: "record",
      record: {
        live: true,
        did: DID,
        collection: "com.kipclip.tag",
        rkey: RKEY,
        action: "create",
        record: { value: "rust", createdAt: "2026-05-09T10:00:00.000Z" },
        cid: "bafytag001",
      },
    },
  },
  {
    name: "tag delete",
    id: 14,
    evt: {
      id: 14,
      type: "record",
      record: {
        live: true,
        did: DID,
        collection: "com.kipclip.tag",
        rkey: RKEY,
        action: "delete",
      },
    },
  },
  {
    name: "preferences create",
    id: 15,
    evt: {
      id: 15,
      type: "record",
      record: {
        live: true,
        did: DID,
        collection: "com.kipclip.preferences",
        rkey: RKEY,
        action: "create",
        record: { dateFormat: "ISO" },
        cid: "bafyprefs001",
      },
    },
  },
  {
    name: "preferences delete",
    id: 16,
    evt: {
      id: 16,
      type: "record",
      record: {
        live: true,
        did: DID,
        collection: "com.kipclip.preferences",
        rkey: RKEY,
        action: "delete",
      },
    },
  },
  {
    name: "identity event",
    id: 17,
    evt: {
      id: 17,
      type: "identity",
      identity: { did: DID, handle: "tijs.org", is_active: true },
    },
  },
  {
    name: "unknown event type",
    id: 18,
    evt: { id: 18, type: "unknown-future-type" },
  },
];

for (const tc of untrackedTests) {
  Deno.test({
    name: `${tc.name} for untracked DID does not create tracked_dids row`,
    async fn() {
      await clearMirrorTables();
      await processEvent(tc.evt);
      assertEquals(
        await trackedDidCount(),
        0,
        `${tc.name}: must not create tracked_dids row for untracked DID`,
      );
    },
  });
}

// --- Completion signal ---

Deno.test({
  name:
    "live event for enrolled DID stamps backfill_complete_at (and is idempotent)",
  async fn() {
    await clearMirrorTables();

    const enrolledAt = Date.now() - 10_000;
    await db.execute({
      sql:
        `INSERT INTO tracked_dids (did, added_at, backfill_started_at, backfill_complete_at, last_event_at)
         VALUES (?, ?, ?, NULL, ?)`,
      args: [DID, enrolledAt, enrolledAt, enrolledAt],
    });

    // First live event: stamps backfill_complete_at
    await processEvent({
      id: 50,
      type: "record",
      record: {
        live: true,
        did: DID,
        collection: "community.lexicon.bookmarks.bookmark",
        rkey: RKEY,
        action: "create",
        record: {
          subject: "https://example.com/live1",
          createdAt: "2026-05-09T10:00:00.000Z",
          tags: [],
        },
        cid: "bafylive001",
      },
    });

    const r1 = await db.execute({
      sql: "SELECT backfill_complete_at FROM tracked_dids WHERE did = ?",
      args: [DID],
    });
    const stamped = Number((r1.rows[0] as unknown[])[0]);
    assertEquals(stamped > 0, true, "backfill_complete_at must be stamped");

    // Second live event: must NOT regress backfill_complete_at
    await processEvent({
      id: 51,
      type: "record",
      record: {
        live: true,
        did: DID,
        collection: "community.lexicon.bookmarks.bookmark",
        rkey: "rkey2",
        action: "create",
        record: {
          subject: "https://example.com/live2",
          createdAt: "2026-05-09T10:01:00.000Z",
          tags: [],
        },
        cid: "bafylive002",
      },
    });

    const r2 = await db.execute({
      sql: "SELECT backfill_complete_at FROM tracked_dids WHERE did = ?",
      args: [DID],
    });
    const stamped2 = Number((r2.rows[0] as unknown[])[0]);
    assertEquals(
      stamped2,
      stamped,
      "backfill_complete_at must not change on subsequent live events",
    );
  },
});

Deno.test({
  name:
    "non-live (backfill) event for enrolled DID does not stamp backfill_complete_at",
  async fn() {
    await clearMirrorTables();

    const enrolledAt = Date.now() - 10_000;
    await db.execute({
      sql:
        `INSERT INTO tracked_dids (did, added_at, backfill_started_at, backfill_complete_at, last_event_at)
         VALUES (?, ?, ?, NULL, ?)`,
      args: [DID, enrolledAt, enrolledAt, enrolledAt],
    });

    await processEvent({
      id: 52,
      type: "record",
      record: {
        live: false,
        did: DID,
        collection: "community.lexicon.bookmarks.bookmark",
        rkey: "rkey-backfill",
        action: "create",
        record: {
          subject: "https://example.com/bf",
          createdAt: "2026-05-09T09:00:00.000Z",
          tags: [],
        },
        cid: "bafybf001",
      },
    });

    const r = await db.execute({
      sql: "SELECT backfill_complete_at FROM tracked_dids WHERE did = ?",
      args: [DID],
    });
    const val = (r.rows[0] as unknown[])[0];
    assertEquals(
      val,
      null,
      "backfill event must not stamp backfill_complete_at",
    );
  },
});
