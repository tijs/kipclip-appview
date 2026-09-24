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
import {
  claimPreviewEnrichmentJobs,
  enqueueMissingPreviewJobsForDid,
  markPreviewJobRetry,
} from "../lib/preview-enrichment-jobs.ts";
import { upsertAnnotation, upsertBookmark } from "../mirror/upserts.ts";
import { processEvent } from "../worker/webhook.ts";

const DID = "did:plc:webhooktest001";
const RKEY = "abc123";
const _URI = `at://${DID}/community.lexicon.bookmarks.bookmark/${RKEY}`;
const YT_SUBJECT = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
const DAY = 24 * 60 * 60 * 1000;

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

// --- Malformed-event log bounding (journal-injection + dedupe Set) ---

Deno.test({
  name:
    "malformed-event warning is bounded: raw collection bucket never reaches the journal",
  async fn() {
    const originalWarn = console.warn;
    const captured: string[] = [];
    // Creator-controlled collection: newlines (journal injection) + a
    // huge tail (unbounded dedupe-set key / log line).
    const bucket = "evil\ninjected\r\nline" + "x".repeat(300);
    const evt = {
      id: 900,
      type: "record",
      record: {
        live: true,
        did: DID,
        collection: bucket,
        rkey: "r1",
        action: "frobnicate", // unknown action -> logMalformedOnce
      },
    };
    console.warn = (...args: unknown[]) => {
      captured.push(args.map(String).join(" "));
    };
    try {
      await processEvent(evt);
      await processEvent(evt); // duplicate must dedupe to a single line
    } finally {
      console.warn = originalWarn;
    }

    assertEquals(
      captured.length,
      1,
      "duplicate malformed events log exactly once",
    );
    const line = captured[0];
    assertEquals(
      line.includes("\n"),
      false,
      "no newline injection into the journal",
    );
    assertEquals(line.includes("\r"), false);
    assertEquals(
      line.includes(bucket),
      false,
      "raw collection bucket must not appear",
    );
    assertEquals(line.includes(DID), false, "full DID must not appear");
    assertEquals(
      line.length < 300,
      true,
      `log line must stay bounded, got ${line.length}`,
    );
  },
});

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

// ============================================================================
// Preview-enrichment job retention: incomplete annotation echoes must not
// erase a pending/failed retry job (the preview worker's own bounded-retry
// write echoed back through the TAP webhook), while a complete annotation
// echo still settles/cancels queued preview work.
// ============================================================================

Deno.test({
  name:
    "incomplete YouTube annotation echo does not erase the pending preview retry job (attempts/backoff preserved)",
  async fn() {
    await clearMirrorTables();
    const rkey = "ytvid";
    const bookmarkUri =
      `at://${DID}/community.lexicon.bookmarks.bookmark/${rkey}`;
    await upsertBookmark({
      uri: bookmarkUri,
      did: DID,
      rkey,
      cid: "bafyytbook",
      subject: YT_SUBJECT,
      createdAt: "2026-05-09T10:00:00.000Z",
    });
    await enqueueMissingPreviewJobsForDid(DID, 10);
    const [job] = await claimPreviewEnrichmentJobs(1);
    assertEquals(job.rkey, rkey);

    // Reproduce the preview worker's bounded-retry state: the partial
    // annotation (no usable description) is already mirrored WITHOUT clearing
    // the job, then the worker persisted attempt #1 with its backoff.
    await upsertAnnotation(
      {
        uri: `at://${DID}/com.kipclip.annotation/${rkey}`,
        did: DID,
        rkey,
        cid: "bafyytann",
        subject: bookmarkUri,
        title: "Real Video Title",
        favicon: "https://www.youtube.com/favicon.ico",
        image: "https://i.ytimg.com/vi/x/hqdefault.jpg",
      },
      { clearPreviewJob: false },
    );
    const retryNow = Date.now();
    await markPreviewJobRetry(
      job,
      new Error("annotation incomplete after enrichment write (bounded retry)"),
      retryNow,
    );

    // TAP echo of the worker's own PDS write arrives through the webhook.
    // The echoed annotation is INCOMPLETE (no description) — it must NOT
    // delete the retry job, or attempts/backoff are lost and the next 60s
    // scan re-enqueues an attempts=0 job forever.
    await processEvent({
      id: 70,
      type: "record",
      record: {
        live: true,
        did: DID,
        collection: "com.kipclip.annotation",
        rkey,
        action: "update",
        record: {
          subject: bookmarkUri,
          title: "Real Video Title",
          favicon: "https://www.youtube.com/favicon.ico",
          image: "https://i.ytimg.com/vi/x/hqdefault.jpg",
        },
        cid: "bafyytann",
      },
    });

    const rows = await db.execute({
      sql:
        "SELECT status, attempts, next_run_at FROM preview_enrichment_jobs WHERE bookmark_uri = ?",
      args: [bookmarkUri],
    });
    assertEquals(
      rows.rows.length,
      1,
      "an incomplete annotation echo must not delete the pending retry job",
    );
    assertEquals(rows.rows[0][0], "pending");
    assertEquals(Number(rows.rows[0][1]), 1);
    assertEquals(
      Number(rows.rows[0][2]),
      retryNow + DAY,
      "the worker's backoff schedule must be preserved",
    );
  },
});

Deno.test({
  name:
    "incomplete YouTube annotation echo does not erase a failed preview retry job",
  async fn() {
    await clearMirrorTables();
    const rkey = "ytfail";
    const bookmarkUri =
      `at://${DID}/community.lexicon.bookmarks.bookmark/${rkey}`;
    await upsertBookmark({
      uri: bookmarkUri,
      did: DID,
      rkey,
      cid: "bafyytfail",
      subject: YT_SUBJECT,
      createdAt: "2026-05-09T10:00:00.000Z",
    });
    await enqueueMissingPreviewJobsForDid(DID, 10);
    const [job] = await claimPreviewEnrichmentJobs(1);
    // Attempt #3 → terminal 'failed' (the bounded retry limit).
    await markPreviewJobRetry(
      { ...job, attempts: 2 },
      new Error("bounded retry exhausted"),
      Date.now(),
    );

    await processEvent({
      id: 72,
      type: "record",
      record: {
        live: true,
        did: DID,
        collection: "com.kipclip.annotation",
        rkey,
        action: "update",
        record: {
          subject: bookmarkUri,
          title: "Real Video Title",
          image: "https://i.ytimg.com/vi/x/hqdefault.jpg",
        },
        cid: "bafyytfail",
      },
    });

    const rows = await db.execute({
      sql:
        "SELECT status, attempts, last_error FROM preview_enrichment_jobs WHERE bookmark_uri = ?",
      args: [bookmarkUri],
    });
    assertEquals(
      rows.rows.length,
      1,
      "an incomplete annotation echo must not delete the failed job",
    );
    assertEquals(rows.rows[0][0], "failed");
    assertEquals(Number(rows.rows[0][1]), 3);
    assertEquals(rows.rows[0][2], "bounded retry exhausted");
  },
});

Deno.test({
  name: "complete annotation webhook echo still settles queued preview work",
  async fn() {
    await clearMirrorTables();
    const rkey = "ytdone";
    const bookmarkUri =
      `at://${DID}/community.lexicon.bookmarks.bookmark/${rkey}`;
    await upsertBookmark({
      uri: bookmarkUri,
      did: DID,
      rkey,
      cid: "bafyytdone",
      subject: YT_SUBJECT,
      createdAt: "2026-05-09T10:00:00.000Z",
    });
    await enqueueMissingPreviewJobsForDid(DID, 10);
    await claimPreviewEnrichmentJobs(1);

    await processEvent({
      id: 71,
      type: "record",
      record: {
        live: true,
        did: DID,
        collection: "com.kipclip.annotation",
        rkey,
        action: "create",
        record: {
          subject: bookmarkUri,
          title: "Real Video Title",
          description: "Real description",
          favicon: "https://www.youtube.com/favicon.ico",
          image: "https://i.ytimg.com/vi/x/hqdefault.jpg",
        },
        cid: "bafyytdone",
      },
    });

    const rows = await db.execute({
      sql:
        "SELECT COUNT(*) FROM preview_enrichment_jobs WHERE bookmark_uri = ?",
      args: [bookmarkUri],
    });
    assertEquals(
      Number(rows.rows[0][0]),
      0,
      "a complete annotation echo must still cancel queued preview work",
    );
  },
});
