import "../runtime/deno/install.ts";
import "./test-setup.ts";
import { assert, assertEquals, assertRejects } from "@std/assert";
import { db } from "./mirror-test-setup.ts";
import {
  checkpointImportChunk,
  cleanupOldJobs,
  completeChunk,
  createImportJob,
  getImportJob,
  getNextPendingChunk,
  markJobCompleted,
  renewImportChunk,
} from "../lib/import-jobs.ts";
import { app } from "../main.ts";
import { setTestSessionProvider } from "../lib/session.ts";
import { createMockSessionResult } from "./test-helpers.ts";

const did = "did:plc:test123";
async function reset() {
  await db.batch([{ sql: "DELETE FROM import_chunks", args: [] }, {
    sql: "DELETE FROM import_jobs",
    args: [],
  }]);
}
const entries = (n: number) =>
  Array.from(
    { length: n },
    (_, i) => ({ url: `https://example.test/${i}`, tags: [] }),
  );

Deno.test("import chunks have one owner and idempotent completion cannot skip pending chunks", async () => {
  await reset();
  const job = await createImportJob(did, "test", 201, 0, entries(201), []);
  const [a, b] = await Promise.all([
    getNextPendingChunk(job.id),
    getNextPendingChunk(job.id),
  ]);
  assert(a);
  assertEquals(b, null);
  await assertRejects(() => createImportJob(did, "test", 1, 0, entries(1), []));
  assert(await completeChunk(a, 200, 0));
  assertEquals(await completeChunk(a, 200, 0), false);
  assertEquals(await markJobCompleted(job.id), false);
  const mid = await getImportJob(job.id);
  assertEquals(mid?.imported, 200);
  assertEquals(mid?.processedChunks, 1);
  const next = await getNextPendingChunk(job.id);
  assert(next);
  assertEquals(next.chunkIndex, 1);
  assert(await completeChunk(next, 1, 0));
  assert(await markJobCompleted(job.id));
  assertEquals((await getImportJob(job.id))?.imported, 201);
});

Deno.test("expired import work keeps stable identities and checkpoints but cannot settle a new lease", async () => {
  await reset();
  const job = await createImportJob(did, "test", 2, 0, entries(2), []);
  const old = await getNextPendingChunk(job.id);
  assert(old);
  assert(await checkpointImportChunk(old, 1, 1, 0));
  await db.execute({
    sql: "UPDATE import_chunks SET lease_until = 0 WHERE id = ?",
    args: [old.id],
  });
  const replacement = await getNextPendingChunk(job.id);
  assert(replacement);
  assertEquals(replacement.bookmarks, old.bookmarks);
  assertEquals(replacement.processedBookmarks, 1);
  assertEquals(replacement.reclaimed, true);
  assertEquals(await renewImportChunk(old), false);
  assertEquals(await completeChunk(old, 2, 0), false);
  assert(await completeChunk(replacement, 2, 0));
});

Deno.test("import expiry compares actual UTC dates and preserves an active lease", async () => {
  await reset();
  const now = Date.parse("2026-11-07T16:00:00Z");
  const old = await createImportJob(
    "did:plc:old",
    "test",
    1,
    0,
    entries(1),
    [],
  );
  const young = await createImportJob(
    "did:plc:young",
    "test",
    1,
    0,
    entries(1),
    [],
  );
  const active = await createImportJob(
    "did:plc:active",
    "test",
    1,
    0,
    entries(1),
    [],
  );
  await db.execute({
    sql:
      "UPDATE import_jobs SET created_at = '2026-11-06 15:59:59' WHERE id IN (?, ?)",
    args: [old.id, active.id],
  });
  await db.execute({
    sql:
      "UPDATE import_jobs SET created_at = '2026-11-06 23:59:59' WHERE id = ?",
    args: [young.id],
  });
  await getNextPendingChunk(active.id, now);
  await cleanupOldJobs(24, now);
  assertEquals(await getImportJob(old.id), null);
  assert(await getImportJob(young.id));
  assert(await getImportJob(active.id));
});

Deno.test("process retry recovers externally committed records at stable IDs instead of creating duplicates", async () => {
  await reset();
  const job = await createImportJob(did, "test", 1, 0, entries(1), []);
  const old = await getNextPendingChunk(job.id);
  assert(old);
  const bookmark = old.bookmarks[0];
  let creates = 0;
  const mock = createMockSessionResult();
  mock.session!.makeRequest = async (_method: string, endpoint: string) => {
    if (endpoint.includes("getRecord")) {
      return Response.json({
        value: {
          subject: bookmark.url,
          createdAt: bookmark.createdAt,
          tags: [],
        },
      });
    }
    if (endpoint.includes("applyWrites")) {
      creates++;
      return Response.json({ results: [] });
    }
    return Response.json({});
  };
  setTestSessionProvider(() => Promise.resolve(mock));
  try {
    const handler = app.handler();
    const url = `https://kipclip.com/api/import/${job.id}/process`;
    const busy = await (await handler(new Request(url, { method: "POST" })))
      .json();
    assertEquals(busy.done, false);
    assertEquals(busy.retryAfterMs, 1000);
    await db.execute({
      sql: "UPDATE import_chunks SET lease_until = 0 WHERE id = ?",
      args: [old.id],
    });
    const res = await handler(new Request(url, { method: "POST" }));
    const body = await res.json();
    assertEquals(res.status, 200);
    assertEquals(body.done, true);
    assertEquals(body.totalImported, 1);
    assertEquals(creates, 0);
  } finally {
    setTestSessionProvider(null);
  }
});
