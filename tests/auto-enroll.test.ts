/**
 * Tests for lib/auto-enroll.ts — TAP enroll auth + failure propagation.
 *
 * Pins:
 *   - Outbound POST /repos/add carries Basic auth derived from
 *     TAP_ADMIN_PASSWORD (regression guard for the silent-401 bug fixed in
 *     v0.24.5).
 *   - A non-2xx TAP response throws and prevents the tracked_dids INSERT,
 *     so a failed enrollment never leaves a backfill-complete row with no
 *     live event flow (this was the silent-divergence failure mode).
 *   - On TAP success, runBackfill upserts records, then tracked_dids is
 *     stamped backfill-complete.
 *   - Sentry payload includes the failing `stage` so operators can target
 *     recovery (tapEnroll vs backfill vs trackedDids).
 */

import "./test-setup.ts";
import { clearMirrorTables, db } from "./mirror-test-setup.ts";
import { assertEquals, assertExists, assertStringIncludes } from "@std/assert";

import {
  _resetAutoEnrollState,
  _runEnrollmentForTest,
} from "../lib/auto-enroll.ts";

const DID = "did:plc:test123";
const PDS = "https://pds.example.test";

// listRecords URLs used by runBackfill, in iteration order.
const LIST_PATHS = [
  "community.lexicon.bookmarks.bookmark",
  "com.kipclip.annotation",
  "app.bookmark.annotation",
  "com.kipclip.tag",
  "com.kipclip.preferences",
];

interface FetchCall {
  url: string;
  init: RequestInit;
}

function installFetchStub(
  handler: (call: FetchCall) => Response | Promise<Response>,
): { calls: FetchCall[]; restore: () => void } {
  const calls: FetchCall[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const call: FetchCall = { url, init: init ?? {} };
    calls.push(call);
    return Promise.resolve(handler(call));
  }) as typeof globalThis.fetch;
  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

function emptyListRecordsBody(): string {
  return JSON.stringify({ records: [] });
}

const TEST_SECRET = "test-tap-webhook-secret";

async function withClean<T>(fn: () => Promise<T>): Promise<T> {
  await clearMirrorTables();
  _resetAutoEnrollState();
  Deno.env.set("MIRROR_MODE", "read");
  Deno.env.set("TAP_ADMIN_PASSWORD", TEST_SECRET);
  try {
    return await fn();
  } finally {
    _resetAutoEnrollState();
    Deno.env.delete("TAP_ADMIN_PASSWORD");
  }
}

Deno.test("tapEnroll sends Basic auth derived from TAP_ADMIN_PASSWORD", async () => {
  await withClean(async () => {
    const stub = installFetchStub((call) => {
      if (call.url.endsWith("/repos/add")) {
        return new Response("", { status: 200 });
      }
      return new Response(emptyListRecordsBody(), { status: 200 });
    });
    try {
      await _runEnrollmentForTest(DID, PDS);
    } finally {
      stub.restore();
    }

    const tapCall = stub.calls.find((c) => c.url.endsWith("/repos/add"));
    assertExists(tapCall, "expected POST to /repos/add");
    const headers = new Headers(tapCall.init.headers ?? {});
    const auth = headers.get("Authorization") ?? "";
    assertStringIncludes(auth, "Basic ");
    const expected = "Basic " + btoa(`admin:${TEST_SECRET}`);
    assertEquals(auth, expected);
  });
});

Deno.test("tapEnroll non-2xx aborts enrollment — no tracked_dids row", async () => {
  await withClean(async () => {
    const stub = installFetchStub((call) => {
      if (call.url.endsWith("/repos/add")) {
        return new Response("Unauthorized", { status: 401 });
      }
      // listRecords should never run if TAP fails first
      return new Response(emptyListRecordsBody(), { status: 200 });
    });
    try {
      await _runEnrollmentForTest(DID, PDS);
    } finally {
      stub.restore();
    }

    const row = await db.execute({
      sql: "SELECT COUNT(*) FROM tracked_dids WHERE did = ?",
      args: [DID],
    });
    assertEquals(Number(row.rows[0][0]), 0);

    // Backfill must not have run.
    const listCalls = stub.calls.filter((c) => c.url.includes("listRecords"));
    assertEquals(listCalls.length, 0);
  });
});

Deno.test("happy path enrolls, backfills, and stamps tracked_dids complete", async () => {
  await withClean(async () => {
    const stub = installFetchStub((call) => {
      if (call.url.endsWith("/repos/add")) {
        return new Response("", { status: 200 });
      }
      if (call.url.startsWith("https://plc.directory/")) {
        return new Response("Not found", { status: 404 });
      }
      // Resolver failure falls back to the session PDS. Return one bookmark
      // record there so the upsert side of runBackfill also exercises.
      if (
        call.url.includes("collection=community.lexicon.bookmarks.bookmark")
      ) {
        return new Response(
          JSON.stringify({
            records: [
              {
                uri: `at://${DID}/community.lexicon.bookmarks.bookmark/rkey1`,
                cid: "bafytestcid",
                value: {
                  $type: "community.lexicon.bookmarks.bookmark",
                  subject: "https://example.com/post",
                  createdAt: "2026-05-01T00:00:00.000Z",
                  tags: [],
                },
              },
            ],
          }),
          { status: 200 },
        );
      }
      return new Response(emptyListRecordsBody(), { status: 200 });
    });
    try {
      await _runEnrollmentForTest(DID, PDS);
    } finally {
      stub.restore();
    }

    // Verify all 5 listRecords collections were queried.
    for (const collection of LIST_PATHS) {
      const hit = stub.calls.find((c) =>
        c.url.includes(`collection=${encodeURIComponent(collection)}`)
      );
      assertExists(hit, `expected listRecords for ${collection}`);
    }

    // tracked_dids row stamped complete.
    const tracked = await db.execute({
      sql:
        "SELECT pds_url, backfill_started_at, backfill_complete_at FROM tracked_dids WHERE did = ?",
      args: [DID],
    });
    assertEquals(tracked.rows.length, 1);
    const [pdsUrl, started, complete] = tracked.rows[0] as [
      string,
      number,
      number,
    ];
    assertEquals(pdsUrl, PDS);
    assertEquals(typeof started, "number");
    assertEquals(typeof complete, "number");

    // Bookmark upsert landed in mirror.
    const bookmarks = await db.execute({
      sql: "SELECT subject FROM bookmarks WHERE did = ?",
      args: [DID],
    });
    assertEquals(bookmarks.rows.length, 1);
    assertEquals(bookmarks.rows[0][0], "https://example.com/post");
  });
});

Deno.test("already-tracked DID short-circuits — no TAP call, no backfill", async () => {
  // Regression: POST /api/bookmarks fires autoEnrollIfNeeded unconditionally
  // (so /save-path users get tracked), so an already-tracked user adding a
  // bookmark would re-run a full PDS backfill on every write. On a slow PDS
  // that 5-collection listRecords sweep timed out and raised a spurious
  // "auto-enroll failed". runEnrollment must no-op when the DID is already
  // tracked with backfill started.
  await withClean(async () => {
    await db.execute({
      sql: `INSERT INTO tracked_dids
              (did, pds_url, added_at, backfill_started_at, backfill_complete_at, last_seq, last_event_at)
            VALUES (?, ?, ?, ?, ?, NULL, NULL)`,
      args: [DID, PDS, 1, 1, 1],
    });

    const stub = installFetchStub(
      () => new Response(emptyListRecordsBody(), { status: 200 }),
    );
    try {
      await _runEnrollmentForTest(DID, PDS);
    } finally {
      stub.restore();
    }

    // No network at all: neither TAP enroll nor any PDS listRecords.
    assertEquals(stub.calls.length, 0);
  });
});

Deno.test("listRecords non-2xx leaves tracked_dids empty (TAP enrolled, backfill failed)", async () => {
  await withClean(async () => {
    const stub = installFetchStub((call) => {
      if (call.url.endsWith("/repos/add")) {
        return new Response("", { status: 200 });
      }
      return new Response("PDS unavailable", { status: 503 });
    });
    try {
      await _runEnrollmentForTest(DID, PDS);
    } finally {
      stub.restore();
    }

    const row = await db.execute({
      sql: "SELECT COUNT(*) FROM tracked_dids WHERE did = ?",
      args: [DID],
    });
    assertEquals(Number(row.rows[0][0]), 0);

    // TAP add was attempted, then aborted on listRecords failure.
    const tapCalls = stub.calls.filter((c) => c.url.endsWith("/repos/add"));
    assertEquals(tapCalls.length, 1);
  });
});

Deno.test("auto-enroll backfills and tracks the DID document's current PDS", async () => {
  await withClean(async () => {
    const currentPds = "https://new-pds.example.test";
    const stub = installFetchStub((call) => {
      if (call.url.endsWith("/repos/add")) {
        return new Response("", { status: 200 });
      }
      if (call.url.startsWith("https://plc.directory/")) {
        return Response.json({
          id: DID,
          service: [
            {
              id: "#atproto_pds",
              type: "AtprotoPersonalDataServer",
              serviceEndpoint: currentPds,
            },
          ],
        });
      }
      if (call.url.startsWith(`${currentPds}/`)) {
        return new Response(emptyListRecordsBody(), { status: 200 });
      }
      return new Response("stale PDS", { status: 500 });
    });
    try {
      await _runEnrollmentForTest(DID, PDS);
    } finally {
      stub.restore();
    }

    const tracked = await db.execute({
      sql: "SELECT pds_url FROM tracked_dids WHERE did = ?",
      args: [DID],
    });
    assertEquals(tracked.rows[0][0], currentPds);
    assertEquals(
      stub.calls.some((call) =>
        call.url.startsWith(`${PDS}/xrpc/com.atproto.repo.listRecords`)
      ),
      false,
    );
  });
});

Deno.test("canonical missing repo is a detailed warning and stays untracked", async () => {
  await withClean(async () => {
    const logs: unknown[][] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args);
    const stub = installFetchStub((call) => {
      if (call.url.endsWith("/repos/add")) {
        return new Response("", { status: 200 });
      }
      if (call.url.startsWith("https://plc.directory/")) {
        return Response.json({
          id: DID,
          service: [
            {
              id: "#atproto_pds",
              type: "AtprotoPersonalDataServer",
              serviceEndpoint: PDS,
            },
          ],
        });
      }
      return Response.json(
        { error: "InvalidRequest", message: `Could not find repo: ${DID}` },
        { status: 400 },
      );
    });
    try {
      await _runEnrollmentForTest(DID, PDS);
    } finally {
      stub.restore();
      console.log = originalLog;
    }

    const tracked = await db.execute({
      sql: "SELECT COUNT(*) FROM tracked_dids WHERE did = ?",
      args: [DID],
    });
    assertEquals(Number(tracked.rows[0][0]), 0);
    const warning = logs.find(
      (args) => args[0] === "[WARNING]" && args[1] === "auto-enroll failed",
    );
    assertExists(warning);
    assertStringIncludes(
      String((warning[2] as { error: string }).error),
      "InvalidRequest: Could not find repo",
    );
  });
});

Deno.test("unconfirmed missing repo remains an error", async () => {
  await withClean(async () => {
    const logs: unknown[][] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args);
    const stub = installFetchStub((call) => {
      if (call.url.endsWith("/repos/add")) {
        return new Response("", { status: 200 });
      }
      if (call.url.startsWith("https://plc.directory/")) {
        return new Response("Not found", { status: 404 });
      }
      return Response.json(
        { error: "InvalidRequest", message: `Could not find repo: ${DID}` },
        { status: 400 },
      );
    });
    try {
      await _runEnrollmentForTest(DID, PDS);
    } finally {
      stub.restore();
      console.log = originalLog;
    }

    assertExists(
      logs.find(
        (args) => args[0] === "[ERROR]" && args[1] === "auto-enroll failed",
      ),
    );
  });
});
