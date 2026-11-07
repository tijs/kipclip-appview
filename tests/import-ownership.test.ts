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
  mock.session!.makeRequest = (_method: string, endpoint: string) => {
    if (endpoint.includes("getRecord")) {
      return Promise.resolve(Response.json({
        value: {
          subject: bookmark.url,
          createdAt: bookmark.createdAt,
          tags: [],
        },
      }));
    }
    if (endpoint.includes("applyWrites")) {
      creates++;
      return Promise.resolve(Response.json({ results: [] }));
    }
    return Promise.resolve(Response.json({}));
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

Deno.test("upgrading an unfinished import preserves completed aggregate totals", async () => {
  await reset();
  const job = await createImportJob(did, "test", 201, 0, entries(201), []);
  await db.execute({
    sql:
      "UPDATE import_chunks SET status='done' WHERE job_id=? AND chunk_index=0",
    args: [job.id],
  });
  await db.execute({
    sql: "UPDATE import_jobs SET imported=200, processed_chunks=1 WHERE id=?",
    args: [job.id],
  });
  // Restore the actual pre-016 schema, then run the production migration.
  for (
    const column of [
      "lease_token",
      "lease_until",
      "imported",
      "failed",
      "processed_bookmarks",
    ]
  ) {
    await db.execute({
      sql: `ALTER TABLE import_chunks DROP COLUMN ${column}`,
      args: [],
    });
  }
  for (const column of ["imported_baseline", "failed_baseline"]) {
    await db.execute({
      sql: `ALTER TABLE import_jobs DROP COLUMN ${column}`,
      args: [],
    });
  }
  await db.execute({
    sql: "DELETE FROM migrations WHERE version='016'",
    args: [],
  });
  const { runMigrations } = await import("../lib/migrations.ts");
  await runMigrations();
  const next = await getNextPendingChunk(job.id);
  assert(next);
  assert(await completeChunk(next, 1, 0));
  assertEquals((await getImportJob(job.id))?.imported, 201);
  assertEquals((await getImportJob(job.id))?.processedChunks, 2);
});

for (const uncertain of ["lost-response", "server-error"] as const) {
  Deno.test(`import recovers ${uncertain} at persisted record IDs without false failure`, async () => {
    await reset();
    const job = await createImportJob(did, "test", 1, 0, entries(1), []);
    const records = new Map<string, unknown>();
    let attempts = 0, commits = 0;
    const mock = createMockSessionResult();
    mock.session!.makeRequest = (
      _method: string,
      endpoint: string,
      options?: any,
    ) => {
      if (endpoint.includes("getRecord")) {
        const query = new URL(endpoint).searchParams;
        const key = `${query.get("collection")}/${query.get("rkey")}`;
        return Promise.resolve(
          records.has(key)
            ? Response.json({ value: records.get(key) })
            : new Response(null, { status: 404 }),
        );
      }
      if (endpoint.includes("applyWrites")) {
        attempts++;
        if (attempts === 1 && uncertain === "server-error") {
          return Promise.resolve(new Response(null, { status: 503 }));
        }
        const writes = JSON.parse(options.body).writes;
        writes.forEach((op: any) =>
          records.set(`${op.collection}/${op.rkey}`, op.value)
        );
        commits++;
        if (attempts === 1) {
          return Promise.reject(new Error("response lost after commit"));
        }
        return Promise.resolve(Response.json({ results: [] }));
      }
      return Promise.resolve(Response.json({}));
    };
    setTestSessionProvider(() => Promise.resolve(mock));
    try {
      const handler = app.handler(),
        url = `https://kipclip.com/api/import/${job.id}/process`;
      const first = await (await handler(new Request(url, { method: "POST" })))
        .json();
      assertEquals(first.done, false);
      assertEquals(first.totalFailed, 0);
      assertEquals(first.retryAfterMs, 1000);
      const recovered =
        await (await handler(new Request(url, { method: "POST" }))).json();
      assertEquals(recovered.done, true);
      assertEquals(recovered.totalImported, 1);
      assertEquals(recovered.totalFailed, 0);
      assertEquals(commits, 1);
    } finally {
      setTestSessionProvider(null);
    }
  });
}

Deno.test("legacy prepared chunks receive unique identities even with identical timestamps and clocks", async () => {
  await reset();
  const job = await createImportJob(did, "test", 200, 0, entries(200), []);
  const legacy = entries(200).map((b) => ({
    ...b,
    createdAt: "2026-01-01T00:00:00Z",
  }));
  await db.execute({
    sql: "UPDATE import_chunks SET bookmarks=? WHERE job_id=?",
    args: [JSON.stringify(legacy), job.id],
  });
  const random = Math.random;
  Math.random = () => 0;
  try {
    const chunk = await getNextPendingChunk(job.id);
    assert(chunk);
    assertEquals(new Set(chunk.bookmarks.map((b) => b.rkey)).size, 200);
  } finally {
    Math.random = random;
  }
});
