import "./test-setup.ts";
import { assertEquals, assertRejects } from "@std/assert";
import { clearMirrorTables, db } from "./mirror-test-setup.ts";
import {
  type BookmarkUpsert,
  deleteBookmark,
  upsertBookmark,
  upsertPreferences,
} from "../mirror/upserts.ts";
import { eventActions } from "../lib/event-actions.ts";
import { backfillBookmarkEvents } from "../lib/bookmark-events.ts";
import {
  backfillEventActions,
  type BookmarkSavedEvent,
} from "../lib/events.ts";
import { runEventTick } from "../lib/event-worker.ts";
import { deliverReadingListBookmark } from "../lib/instapaper-bookmark-action.ts";
import { updateUserSettings } from "../lib/settings.ts";
import { processEvent } from "../worker/webhook.ts";
import { upsertLiveRepo } from "../lib/mirror-sync.ts";

const DID = "did:plc:eventtest";
function bookmark(
  id = "one",
  patch: Partial<BookmarkUpsert> = {},
): BookmarkUpsert {
  return {
    uri: `at://${DID}/community.lexicon.bookmarks.bookmark/${id}`,
    did: DID,
    rkey: id,
    cid: `cid-${id}`,
    subject: `https://example.invalid/${id}`,
    createdAt: "2026-01-01T00:00:00Z",
    tags: ["ToRead"],
    ...patch,
  };
}
function event(b: BookmarkUpsert): BookmarkSavedEvent {
  return {
    type: "bookmark.saved",
    bookmark: b,
    key: b.uri,
    did: b.did,
    version: b.cid,
  };
}
async function query(sql: string, args: unknown[] = []) {
  return (await db.execute({ sql, args })).rows;
}
async function enable(did = DID) {
  await updateUserSettings(did, {
    instapaperEnabled: true,
    instapaperUsername: "dummy@example.invalid",
    instapaperPassword: "dummy-password",
  });
}
const noBackfill = { backfillLimit: 0, batchSize: 20 };
const withTag = (tag: string | null = "toread") => [
  eventActions[2],
  eventActions[0],
  {
    id: "instapaper",
    run: (evt: BookmarkSavedEvent) =>
      deliverReadingListBookmark(evt, () => Promise.resolve(tag)),
  },
];

Deno.test("all bookmark sources emit identical registered jobs, including historical records", async () => {
  await clearMirrorTables();
  await upsertBookmark(bookmark("ui"));
  for (const live of [true, false]) {
    const b = bookmark(live ? "tap" : "tap-backfill");
    await processEvent({
      type: "record",
      record: {
        live,
        did: DID,
        collection: "community.lexicon.bookmarks.bookmark",
        rkey: b.rkey,
        cid: b.cid,
        action: "create",
        record: { subject: b.subject, createdAt: b.createdAt, tags: b.tags },
      },
    });
  }
  const b = bookmark("pds-backfill");
  await upsertLiveRepo(DID, {
    bookmarks: [{
      uri: b.uri,
      cid: b.cid,
      value: { subject: b.subject, createdAt: b.createdAt, tags: b.tags },
    }],
    kipclipAnnotations: [],
    legacyAnnotations: [],
    tags: [],
    preferences: [],
  });
  assertEquals(
    await query(
      "SELECT action, COUNT(*) FROM event_action_jobs GROUP BY action ORDER BY action",
    ),
    [["instapaper", 4], ["preview", 4]],
  );
  // Simulate a pre-upgrade mirror: no event/job existed when it was indexed.
  await db.execute({ sql: "DELETE FROM event_action_jobs", args: [] });
  await db.execute({ sql: "DELETE FROM app_events", args: [] });
  assertEquals(await backfillBookmarkEvents(2), 2);
  assertEquals(await query("SELECT COUNT(*) FROM app_events"), [[2]]);
  assertEquals(await backfillBookmarkEvents(2), 2);
  assertEquals(await backfillBookmarkEvents(2), 0);
  await db.execute({
    sql:
      "DELETE FROM event_action_jobs WHERE action = 'preview' AND event_key = ?",
    args: [b.uri],
  });
  assertEquals(await backfillEventActions(2), 1);
  assertEquals(await query("SELECT COUNT(*) FROM event_action_jobs"), [[8]]);
});

Deno.test("bookmark mirror and events roll back together; cross-DID writes emit nothing", async () => {
  await clearMirrorTables();
  const original = db.batch;
  db.batch = (statements) =>
    original([...statements, {
      sql: "INSERT INTO nonexistent_event_table VALUES (1)",
      args: [],
    }]);
  try {
    await assertRejects(() => upsertBookmark(bookmark()));
  } finally {
    db.batch = original;
  }
  assertEquals(await query("SELECT COUNT(*) FROM bookmarks"), [[0]]);
  assertEquals(await query("SELECT COUNT(*) FROM app_events"), [[0]]);
  assertEquals(await query("SELECT COUNT(*) FROM event_action_jobs"), [[0]]);
  await assertRejects(() =>
    upsertBookmark(bookmark("cross", { did: "did:plc:other" }))
  );
});

Deno.test("listener failure is isolated, bounded, and stable across echoes and scans", async () => {
  await clearMirrorTables();
  const b = bookmark();
  await upsertBookmark(b);
  let successes = 0;
  const actions = [{
    id: "preview",
    run: () => {
      successes++;
      return Promise.resolve();
    },
  }, {
    id: "instapaper",
    run: () => Promise.reject(new Error("temporary service failure")),
  }];
  const stats = await runEventTick(noBackfill, actions);
  assertEquals([stats.success, stats.retry, successes], [1, 1, 1]);
  assertEquals((await runEventTick(noBackfill, actions)).processed, 0);
  for (let i = 0; i < 4; i++) {
    await db.execute({
      sql:
        "UPDATE event_action_jobs SET next_run_at = 0 WHERE action = 'instapaper'",
      args: [],
    });
    await runEventTick(noBackfill, actions);
  }
  await upsertBookmark(b);
  await backfillBookmarkEvents();
  assertEquals(
    await query(
      "SELECT status, attempts FROM event_action_jobs WHERE action = 'instapaper'",
    ),
    [["failed", 5]],
  );
  assertEquals(successes, 1);
});

Deno.test("expired leases recover; stale completion cannot finish a newer event; deletion cancels jobs", async () => {
  await clearMirrorTables();
  const b = bookmark();
  await upsertBookmark(b);
  await db.execute({
    sql: "UPDATE event_action_jobs SET status = 'running', lease_until = ?",
    args: [Date.now() + 600_000],
  });
  assertEquals((await runEventTick(noBackfill)).processed, 0);
  await db.execute({
    sql: "UPDATE event_action_jobs SET lease_until = 0",
    args: [],
  });
  const newer = { ...b, cid: "new-cid" };
  const stats = await runEventTick(
    { backfillLimit: 0, batchSize: 1 },
    [
      { id: "instapaper", run: () => upsertBookmark(newer) },
      { id: "preview", run: () => Promise.resolve() },
    ],
  );
  assertEquals(stats.processed, 1);
  assertEquals(
    await query("SELECT DISTINCT version, status FROM event_action_jobs"),
    [["new-cid", "pending"]],
  );
  await deleteBookmark(b.uri, DID);
  assertEquals(await query("SELECT COUNT(*) FROM app_events"), [[0]]);
  assertEquals(await query("SELECT COUNT(*) FROM event_action_jobs"), [[0]]);
});

Deno.test("Instapaper delivers historical bookmarks once across echoes, metadata edits and tag toggles", async () => {
  await clearMirrorTables();
  await enable();
  let b = bookmark();
  await upsertBookmark(b);
  const oldFetch = globalThis.fetch;
  const deliveries: string[] = [];
  globalThis.fetch = (input, init) => {
    const url = new URL(String(input));
    assertEquals(url.hostname, "www.instapaper.com");
    assertEquals(
      new Headers(init?.headers).get("Authorization"),
      "Basic " + btoa("dummy@example.invalid:dummy-password"),
    );
    deliveries.push(url.searchParams.get("url")!);
    return Promise.resolve(new Response(null, { status: 201 }));
  };
  try {
    await runEventTick(noBackfill, withTag());
    await upsertBookmark(b); // TAP echo; completed jobs remain done.
    await runEventTick(noBackfill, withTag());
    for (const tags of [[], ["toread"], ["ToRead", "other"]]) {
      b = { ...b, tags, cid: b.cid + "x" };
      await upsertBookmark(b);
      await runEventTick(noBackfill, withTag());
    }
    assertEquals(deliveries, [b.subject]);
    assertEquals(await query("SELECT status FROM instapaper_deliveries"), [[
      "sent",
    ]]);
    b = {
      ...b,
      cid: "changed-url",
      subject: "https://example.invalid/changed",
    };
    await upsertBookmark(b);
    await runEventTick(noBackfill, withTag());
    assertEquals(deliveries.length, 2);
  } finally {
    globalThis.fetch = oldFetch;
  }
});

Deno.test("disabled connections, custom tags and unknown preferences never send by guesswork", async () => {
  await clearMirrorTables();
  await enable();
  const b = bookmark();
  await upsertBookmark(b);
  const oldFetch = globalThis.fetch;
  let deliveries = 0;
  globalThis.fetch = () => {
    deliveries++;
    return Promise.resolve(new Response(null, { status: 201 }));
  };
  try {
    await updateUserSettings(DID, { instapaperEnabled: false });
    await runEventTick(noBackfill, withTag());
    assertEquals(deliveries, 0);
    await enable(); // Re-evaluates historical records without needing a record edit.
    await runEventTick(noBackfill, withTag("custom"));
    assertEquals(deliveries, 0);
    await upsertPreferences({
      did: DID,
      cid: "prefs-new",
      readingListTag: "toread",
    });
    await runEventTick(noBackfill, withTag(null));
    assertEquals(deliveries, 0);
    assertEquals(
      await query(
        "SELECT status, attempts FROM event_action_jobs WHERE action = 'instapaper'",
      ),
      [["pending", 1]],
    );
    await db.execute({
      sql: "UPDATE event_action_jobs SET next_run_at = 0",
      args: [],
    });
    await runEventTick(noBackfill, withTag());
    assertEquals(deliveries, 1);
  } finally {
    globalThis.fetch = oldFetch;
  }
});

Deno.test("public PDS preferences support defaults/custom tags without restoring OAuth", async () => {
  await clearMirrorTables();
  await enable();
  const oldFetch = globalThis.fetch;
  let preference = () =>
    Response.json({ error: "RecordNotFound" }, { status: 400 });
  let deliveries = 0;
  let currentBookmark = bookmark();
  globalThis.fetch = (input) => {
    const url = new URL(String(input));
    if (url.hostname === "plc.directory") {
      return Promise.resolve(
        Response.json({
          service: [{
            id: "#atproto_pds",
            serviceEndpoint: "https://pds.example.invalid",
          }],
        }),
      );
    }
    if (url.hostname === "pds.example.invalid") {
      if (
        url.searchParams.get("collection") ===
          "community.lexicon.bookmarks.bookmark"
      ) {
        return Promise.resolve(
          Response.json({
            cid: currentBookmark.cid,
            value: { subject: currentBookmark.subject },
          }),
        );
      }
      return Promise.resolve(preference());
    }
    assertEquals(url.hostname, "www.instapaper.com");
    deliveries++;
    return Promise.resolve(new Response(null, { status: 201 }));
  };
  try {
    for (
      const valid of [
        () => Response.json({ error: "RecordNotFound" }, { status: 400 }),
        () => Response.json({ error: "RecordNotFound" }, { status: 404 }),
        () => Response.json({ value: { dateFormat: "us" } }),
        () => Response.json({ value: { readingListTag: "READ-LATER" } }),
      ]
    ) {
      preference = valid;
      const b = bookmark(`valid-${deliveries}`, {
        tags: ["toread", "Read-Later"],
      });
      currentBookmark = b;
      await upsertBookmark(b);
      await deliverReadingListBookmark(event(b));
    }
    assertEquals(deliveries, 4);
    for (
      const invalid of [
        () => new Response(null, { status: 503 }),
        () => new Response(null, { status: 403 }),
        () => Response.json({ value: { readingListTag: 42 } }),
        () => Response.json({}),
        () => new Response("not json"),
        () => {
          throw new Error("network unavailable");
        },
      ]
    ) {
      preference = invalid;
      const b = bookmark("invalid");
      currentBookmark = b;
      await upsertBookmark(b);
      await assertRejects(
        () => deliverReadingListBookmark(event(b)),
        Error,
        "preference unavailable",
      );
    }
    assertEquals(deliveries, 4);
  } finally {
    globalThis.fetch = oldFetch;
  }
});

Deno.test("Instapaper failures remain retryable and concurrent sends share a delivery lease", async () => {
  await clearMirrorTables();
  await enable();
  const b = bookmark();
  await upsertBookmark(b);
  const oldFetch = globalThis.fetch;
  let deliveries = 0;
  let response = () => Promise.resolve(new Response(null, { status: 500 }));
  globalThis.fetch = () => {
    deliveries++;
    return response();
  };
  const deliver = () =>
    deliverReadingListBookmark(event(b), () => Promise.resolve("toread"));
  try {
    await assertRejects(deliver, Error, "Instapaper service error");
    assertEquals(await query("SELECT status FROM instapaper_deliveries"), [[
      "pending",
    ]]);
    let release!: (response: Response) => void;
    let started!: () => void;
    const sending = new Promise<void>((resolve) => {
      started = resolve;
    });
    response = () => {
      started();
      return new Promise<Response>((resolve) => {
        release = resolve;
      });
    };
    const first = deliver();
    await sending;
    try {
      await assertRejects(deliver, Error, "already in progress");
    } finally {
      release(new Response(null, { status: 201 }));
    }
    await first;
    await deliver();
    assertEquals(deliveries, 2);
    assertEquals(await query("SELECT status FROM instapaper_deliveries"), [[
      "sent",
    ]]);
  } finally {
    globalThis.fetch = oldFetch;
  }
});

Deno.test("new subscriptions catch up for configuration events; preference echoes preserve failure backoff", async () => {
  await clearMirrorTables();
  await upsertPreferences({
    did: DID,
    cid: "prefs-1",
    readingListTag: "custom",
  });
  assertEquals(await query("SELECT type FROM app_events"), [[
    "preferences.changed",
  ]]);
  await db.execute({ sql: "DELETE FROM event_action_jobs", args: [] });
  assertEquals(await backfillEventActions(), 1);
  assertEquals(await query("SELECT action FROM event_action_jobs"), [[
    "instapaper.reconcile",
  ]]);
  await db.execute({
    sql:
      "UPDATE event_action_jobs SET status = 'failed', attempts = 5, next_run_at = 1234",
    args: [],
  });
  await upsertPreferences({
    did: DID,
    cid: "prefs-1",
    readingListTag: "custom",
  });
  assertEquals(
    await query("SELECT status, attempts, next_run_at FROM event_action_jobs"),
    [["failed", 5, 1234]],
  );
  await upsertPreferences({
    did: DID,
    cid: "prefs-2",
    readingListTag: "toread",
  });
  assertEquals(
    await query("SELECT version, status, attempts FROM event_action_jobs"),
    [["prefs-2", "pending", 0]],
  );
});

Deno.test("configuration state and change events commit or roll back together", async () => {
  await clearMirrorTables();
  await updateUserSettings(DID, { instapaperEnabled: false });
  const original = db.batch;
  db.batch = (statements) =>
    original([...statements, {
      sql: "INSERT INTO nonexistent_event_table VALUES (1)",
      args: [],
    }]);
  try {
    await assertRejects(() =>
      upsertPreferences({ did: DID, cid: "not-committed" })
    );
    await assertRejects(() => enable());
  } finally {
    db.batch = original;
  }
  assertEquals(
    await query("SELECT COUNT(*) FROM preferences WHERE did = ?", [DID]),
    [[0]],
  );
  assertEquals(
    await query("SELECT instapaper_enabled FROM user_settings WHERE did = ?", [
      DID,
    ]),
    [[0]],
  );
  assertEquals(
    await query(
      "SELECT COUNT(*) FROM app_events WHERE version = 'not-committed'",
    ),
    [[0]],
  );
});

Deno.test("webhook database failure remains retryable even with fast acknowledgements enabled", async () => {
  await clearMirrorTables();
  const { handleWebhookRequest } = await import("../worker/webhook.ts");
  const oldAck = Deno.env.get("MIRROR_WEBHOOK_ACK_ASYNC");
  const oldSecret = Deno.env.get("TAP_ADMIN_PASSWORD");
  Deno.env.set("MIRROR_WEBHOOK_ACK_ASYNC", "1");
  Deno.env.delete("TAP_ADMIN_PASSWORD");
  const b = bookmark("retry-webhook");
  const request = () =>
    new Request("https://kipclip.com/api/sync/hook", {
      method: "POST",
      body: JSON.stringify({
        id: 987654,
        type: "record",
        record: {
          live: true,
          did: DID,
          collection: "community.lexicon.bookmarks.bookmark",
          rkey: b.rkey,
          cid: b.cid,
          action: "create",
          record: { subject: b.subject, createdAt: b.createdAt, tags: b.tags },
        },
      }),
    });
  const original = db.batch;
  try {
    db.batch = () => Promise.reject(new Error("fixture database failure"));
    assertEquals((await handleWebhookRequest(request())).status, 500);
    assertEquals(await query("SELECT COUNT(*) FROM seen_webhook_deliveries"), [[
      0,
    ]]);
    db.batch = original;
    assertEquals((await handleWebhookRequest(request())).status, 200);
    assertEquals(await query("SELECT COUNT(*) FROM event_action_jobs"), [[2]]);
    assertEquals(
      (await (await handleWebhookRequest(request())).json()).replayed,
      true,
    );
  } finally {
    db.batch = original;
    if (oldAck === undefined) Deno.env.delete("MIRROR_WEBHOOK_ACK_ASYNC");
    else Deno.env.set("MIRROR_WEBHOOK_ACK_ASYNC", oldAck);
    if (oldSecret === undefined) Deno.env.delete("TAP_ADMIN_PASSWORD");
    else Deno.env.set("TAP_ADMIN_PASSWORD", oldSecret);
  }
});

Deno.test("separate worker instances cannot claim the same listener job", async () => {
  await clearMirrorTables();
  await upsertBookmark(bookmark("two-workers"));
  await db.execute({
    sql: "DELETE FROM event_action_jobs WHERE action = 'preview'",
    args: [],
  });
  const other = await import("../lib/event-worker.ts?second-worker");
  let release!: () => void;
  let claimed!: () => void;
  const started = new Promise<void>((resolve) => {
    claimed = resolve;
  });
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  const actions = [{
    id: "instapaper",
    run: async () => {
      calls++;
      claimed();
      await wait;
    },
  }];
  const first = runEventTick({ backfillLimit: 0, batchSize: 1 }, actions);
  await started;
  try {
    assertEquals(
      (await other.runEventTick({ backfillLimit: 0, batchSize: 1 }, actions))
        .processed,
      0,
    );
    assertEquals(calls, 1);
  } finally {
    release();
    await first;
  }
});

Deno.test("real registry delivers TAP bookmarks, tag additions and historical discovery end to end", async () => {
  await clearMirrorTables();
  await enable();
  const oldFetch = globalThis.fetch;
  const delivered: string[] = [];
  const records = new Map<string, BookmarkUpsert>();
  globalThis.fetch = (input) => {
    const url = new URL(String(input));
    if (url.hostname === "plc.directory") {
      return Promise.resolve(
        Response.json({
          service: [{
            id: "#atproto_pds",
            serviceEndpoint: "https://pds.example.invalid",
          }],
        }),
      );
    }
    if (url.hostname === "pds.example.invalid") {
      if (
        url.searchParams.get("collection") ===
          "community.lexicon.bookmarks.bookmark"
      ) {
        const current = records.get(url.searchParams.get("rkey")!);
        return Promise.resolve(
          current
            ? Response.json({
              cid: current.cid,
              value: { subject: current.subject },
            })
            : Response.json({ error: "RecordNotFound" }, { status: 400 }),
        );
      }
      return Promise.resolve(
        Response.json({ error: "RecordNotFound" }, { status: 400 }),
      );
    }
    assertEquals(url.hostname, "www.instapaper.com");
    delivered.push(url.searchParams.get("url")!);
    return Promise.resolve(new Response(null, { status: 201 }));
  };
  const tap = (b: BookmarkUpsert) =>
    processEvent({
      type: "record",
      record: {
        did: DID,
        live: true,
        collection: "community.lexicon.bookmarks.bookmark",
        rkey: b.rkey,
        cid: b.cid,
        action: "create",
        record: { subject: b.subject, createdAt: b.createdAt, tags: b.tags },
      },
    });
  try {
    const created = bookmark("disperse");
    const later = bookmark("later-tag", { tags: [] });
    records.set(created.rkey, created);
    records.set(later.rkey, later);
    await tap(created);
    await tap(later);
    const history = bookmark("historical");
    records.set(history.rkey, history);
    await db.execute({
      sql:
        "INSERT INTO bookmarks (uri, did, rkey, cid, subject, created_at, tags, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      args: [
        history.uri,
        DID,
        history.rkey,
        history.cid,
        history.subject,
        history.createdAt,
        JSON.stringify(history.tags),
        Date.now(),
      ],
    });
    await runEventTick({ batchSize: 20, backfillLimit: 5 });
    assertEquals(delivered.sort(), [created.subject, history.subject].sort());
    const tagged = { ...later, cid: "later-tagged-cid", tags: ["TOREAD"] };
    records.set(tagged.rkey, tagged);
    await tap(tagged);
    await runEventTick({ batchSize: 20 });
    assertEquals(delivered.length, 3);
    records.set(tagged.rkey, tagged);
    await tap(tagged);
    await runEventTick({ batchSize: 20 });
    assertEquals(delivered.length, 3);
    assertEquals(await query("SELECT COUNT(*) FROM preview_enrichment_jobs"), [[
      3,
    ]]);
  } finally {
    globalThis.fetch = oldFetch;
  }
});

Deno.test("pending preference reads cannot send after a bookmark changes, is deleted, or its connection is disabled", async () => {
  const oldFetch = globalThis.fetch;
  let deliveries = 0;
  globalThis.fetch = () => {
    deliveries++;
    return Promise.resolve(new Response(null, { status: 201 }));
  };
  try {
    for (
      const change of [
        (b: BookmarkUpsert) =>
          upsertBookmark({ ...b, cid: "removed-tag", tags: [] }),
        (b: BookmarkUpsert) => deleteBookmark(b.uri, DID),
        () => updateUserSettings(DID, { instapaperEnabled: false }),
      ]
    ) {
      await clearMirrorTables();
      await enable();
      const b = bookmark();
      await upsertBookmark(b);
      let release!: (tag: string) => void;
      let reading!: () => void;
      const started = new Promise<void>((resolve) => {
        reading = resolve;
      });
      const tag = new Promise<string>((resolve) => {
        release = resolve;
      });
      const sending = deliverReadingListBookmark(event(b), () => {
        reading();
        return tag;
      });
      await started;
      try {
        await change(b);
      } finally {
        release("toread");
      }
      await sending;
      assertEquals(deliveries, 0);
      assertEquals(await query("SELECT COUNT(*) FROM instapaper_deliveries"), [[
        0,
      ]]);
    }
  } finally {
    globalThis.fetch = oldFetch;
  }
});

Deno.test("delivery history follows the recipient account and survives password rotation", async () => {
  await clearMirrorTables();
  await enable();
  const b = bookmark();
  await upsertBookmark(b);
  const oldFetch = globalThis.fetch;
  const recipients: string[] = [];
  globalThis.fetch = (_input, init) => {
    recipients.push(
      atob(new Headers(init?.headers).get("Authorization")!.slice(6)).split(
        ":",
      )[0],
    );
    return Promise.resolve(new Response(null, { status: 201 }));
  };
  try {
    await runEventTick(noBackfill, withTag());
    await updateUserSettings(DID, {
      instapaperEnabled: true,
      instapaperUsername: "second@example.invalid",
      instapaperPassword: "new-password",
    });
    await runEventTick(noBackfill, withTag());
    await updateUserSettings(DID, {
      instapaperEnabled: true,
      instapaperPassword: "rotated-password",
    });
    await runEventTick(noBackfill, withTag());
    assertEquals(recipients, [
      "dummy@example.invalid",
      "second@example.invalid",
    ]);
    assertEquals(
      await query(
        "SELECT COUNT(DISTINCT account_key) FROM instapaper_deliveries WHERE status = 'sent'",
      ),
      [[2]],
    );
  } finally {
    globalThis.fetch = oldFetch;
  }
});

Deno.test("subscription catch-up replaces jobs left behind at an old event version", async () => {
  await clearMirrorTables();
  await upsertPreferences({ did: DID, cid: "current" });
  await db.execute({
    sql: "UPDATE event_action_jobs SET version = 'old', status = 'done'",
    args: [],
  });
  assertEquals(await backfillEventActions(), 1);
  assertEquals(await query("SELECT version, status FROM event_action_jobs"), [[
    "current",
    "pending",
  ]]);
});

Deno.test("authoritative bookmark checks suppress delayed deleted/obsolete echoes and retry unknown state", async () => {
  await clearMirrorTables();
  await enable();
  const b = bookmark("late-echo");
  await upsertBookmark(b);
  const oldFetch = globalThis.fetch;
  let response = () =>
    Response.json({ error: "RecordNotFound" }, { status: 400 });
  let deliveries = 0;
  globalThis.fetch = (input) => {
    const url = new URL(String(input));
    if (url.hostname === "plc.directory") {
      return Promise.resolve(
        Response.json({
          service: [{
            id: "#atproto_pds",
            serviceEndpoint: "https://pds.example.invalid",
          }],
        }),
      );
    }
    if (url.hostname === "pds.example.invalid") {
      return Promise.resolve(response());
    }
    deliveries++;
    return Promise.resolve(new Response(null, { status: 201 }));
  };
  try {
    for (
      const knownObsolete of [
        () => Response.json({ error: "RecordNotFound" }, { status: 400 }),
        () => Response.json({ error: "RecordNotFound" }, { status: 404 }),
        () =>
          Response.json({ cid: "newer-cid", value: { subject: b.subject } }),
        () =>
          Response.json({
            cid: b.cid,
            value: { subject: "https://example.invalid/changed" },
          }),
      ]
    ) {
      response = knownObsolete;
      await deliverReadingListBookmark(event(b));
    }
    for (
      const unknown of [
        () => new Response(null, { status: 503 }),
        () => Response.json({}),
        () => new Response("not json"),
      ]
    ) {
      response = unknown;
      await assertRejects(() => deliverReadingListBookmark(event(b)));
    }
    assertEquals(deliveries, 0);
    assertEquals(await query("SELECT COUNT(*) FROM instapaper_deliveries"), [[
      0,
    ]]);
  } finally {
    globalThis.fetch = oldFetch;
  }
});
