import { assertEquals } from "@std/assert";
import { clearMirrorTables, db } from "./mirror-test-setup.ts";
import { upsertAnnotation, upsertBookmark } from "../mirror/upserts.ts";
import {
  claimPreviewEnrichmentJobs,
  enqueueMissingPreviewJobsForDid,
  findMissingPreviewBookmarks,
  markPreviewJobRetry,
} from "../lib/preview-enrichment-jobs.ts";
import {
  processPreviewEnrichmentJob,
  runPreviewEnrichmentTick,
} from "../lib/preview-enrichment-worker.ts";

const DID = "did:plc:previewtest";

async function bookmark(rkey: string, subject = `https://example.com/${rkey}`) {
  await upsertBookmark({
    uri: `at://${DID}/community.lexicon.bookmarks.bookmark/${rkey}`,
    did: DID,
    rkey,
    cid: `bafy${rkey}`,
    subject,
    createdAt: new Date().toISOString(),
  });
}

Deno.test("preview jobs enqueue idempotently for missing annotations", async () => {
  await clearMirrorTables();
  await bookmark("a");

  assertEquals(await enqueueMissingPreviewJobsForDid(DID, 10), 1);
  assertEquals(await enqueueMissingPreviewJobsForDid(DID, 10), 1);

  const rows = await db.execute({
    sql: "SELECT COUNT(*) FROM preview_enrichment_jobs WHERE did = ?",
    args: [DID],
  });
  assertEquals(Number(rows.rows[0][0]), 1);
});

Deno.test("missing preview query excludes annotation with preview data", async () => {
  await clearMirrorTables();
  await bookmark("plain");
  await bookmark("rich");
  await upsertAnnotation({
    uri: `at://${DID}/com.kipclip.annotation/rich`,
    did: DID,
    rkey: "rich",
    cid: "bafyann",
    subject: `at://${DID}/community.lexicon.bookmarks.bookmark/rich`,
    title: "Already rich",
  });

  const missing = await findMissingPreviewBookmarks(DID, 10);
  assertEquals(
    missing.map((b) => b.rkey),
    ["plain"],
  );
});

Deno.test("claim returns runnable pending jobs without persistent running state", async () => {
  await clearMirrorTables();
  await bookmark("a");
  await enqueueMissingPreviewJobsForDid(DID, 10);

  const jobs = await claimPreviewEnrichmentJobs(5);
  assertEquals(jobs.length, 1);
  assertEquals(jobs[0].rkey, "a");

  const rows = await db.execute({
    sql: "SELECT status FROM preview_enrichment_jobs WHERE bookmark_uri = ?",
    args: [jobs[0].bookmarkUri],
  });
  assertEquals(rows.rows[0][0], "pending");
});

Deno.test("retry schedule stops after third failure", async () => {
  await clearMirrorTables();
  await bookmark("a");
  await enqueueMissingPreviewJobsForDid(DID, 10);
  let job = (await claimPreviewEnrichmentJobs(1))[0];

  assertEquals(
    await markPreviewJobRetry(job, new Error("first"), 1_000),
    "pending",
  );
  let rows = await db.execute({
    sql:
      "SELECT status, attempts, next_run_at FROM preview_enrichment_jobs WHERE bookmark_uri = ?",
    args: [job.bookmarkUri],
  });
  assertEquals(rows.rows[0], ["pending", 1, 86_401_000]);

  job = { ...job, attempts: 1 };
  assertEquals(
    await markPreviewJobRetry(job, new Error("second"), 1_000),
    "pending",
  );
  rows = await db.execute({
    sql:
      "SELECT status, attempts, next_run_at FROM preview_enrichment_jobs WHERE bookmark_uri = ?",
    args: [job.bookmarkUri],
  });
  assertEquals(rows.rows[0], ["pending", 2, 604_801_000]);

  job = { ...job, attempts: 2 };
  assertEquals(
    await markPreviewJobRetry(job, new Error("third"), 1_000),
    "failed",
  );
  rows = await db.execute({
    sql:
      "SELECT status, attempts, next_run_at FROM preview_enrichment_jobs WHERE bookmark_uri = ?",
    args: [job.bookmarkUri],
  });
  assertEquals(rows.rows[0], ["failed", 3, 1_000]);
  assertEquals(await claimPreviewEnrichmentJobs(1, 2_000), []);
});

Deno.test("upsertAnnotation clears queued preview job", async () => {
  await clearMirrorTables();
  await bookmark("a");
  await enqueueMissingPreviewJobsForDid(DID, 10);

  await upsertAnnotation({
    uri: `at://${DID}/com.kipclip.annotation/a`,
    did: DID,
    rkey: "a",
    cid: "bafyann",
    subject: `at://${DID}/community.lexicon.bookmarks.bookmark/a`,
    title: "Done",
  });

  const rows = await db.execute({
    sql: "SELECT COUNT(*) FROM preview_enrichment_jobs WHERE did = ?",
    args: [DID],
  });
  assertEquals(Number(rows.rows[0][0]), 0);
});

Deno.test("worker blocks when no OAuth session is restorable", async () => {
  await clearMirrorTables();
  await bookmark("a");
  await enqueueMissingPreviewJobsForDid(DID, 10);

  const stats = await runPreviewEnrichmentTick({ batchSize: 1 });
  assertEquals(stats.skippedNoSession, 1);

  const rows = await db.execute({
    sql: "SELECT status, last_error FROM preview_enrichment_jobs WHERE did = ?",
    args: [DID],
  });
  assertEquals(rows.rows[0], ["blocked_no_session", "no usable OAuth session"]);
});

Deno.test("worker writes annotation and marks job done", async () => {
  await clearMirrorTables();
  await bookmark("a");
  await enqueueMissingPreviewJobsForDid(DID, 10);
  const job = (await claimPreviewEnrichmentJobs(1))[0];

  const stats = await processPreviewEnrichmentJob(job, {
    restoreSession: () =>
      Promise.resolve({ did: DID, pdsUrl: "https://pds.test" }),
    extractUrlMetadata: () =>
      Promise.resolve({
        title: "Title",
        description: "Desc",
        favicon: "https://example.com/favicon.ico",
        image: "https://example.com/og.png",
      }),
    writeAnnotation: (_session, rkey, annotation) => {
      assertEquals(rkey, "a");
      assertEquals(
        annotation.subject,
        `at://${DID}/community.lexicon.bookmarks.bookmark/a`,
      );
      return Promise.resolve({
        ok: true,
        uri: `at://${DID}/com.kipclip.annotation/a`,
        cid: "bafyann",
      });
    },
  });
  assertEquals(stats.success, 1);

  const rows = await db.execute({
    sql: "SELECT COUNT(*) FROM preview_enrichment_jobs WHERE bookmark_uri = ?",
    args: [job.bookmarkUri],
  });
  assertEquals(Number(rows.rows[0][0]), 0);
  const annotations = await db.execute({
    sql: "SELECT title, favicon FROM annotations WHERE subject = ?",
    args: [job.bookmarkUri],
  });
  assertEquals(annotations.rows[0], [
    "Title",
    "https://example.com/favicon.ico",
  ]);
});

Deno.test("worker skips existing note-only annotation and does not write", async () => {
  await clearMirrorTables();
  await bookmark("a");
  await enqueueMissingPreviewJobsForDid(DID, 10);
  const job = (await claimPreviewEnrichmentJobs(1))[0];
  await upsertAnnotation({
    uri: `at://${DID}/com.kipclip.annotation/a`,
    did: DID,
    rkey: "a",
    cid: "bafyann",
    subject: job.bookmarkUri,
    note: "keep this",
  });

  let wrote = false;
  const stats = await processPreviewEnrichmentJob(job, {
    restoreSession: () => Promise.resolve({ did: DID }),
    writeAnnotation: () => {
      wrote = true;
      return Promise.resolve({ ok: true });
    },
  });
  assertEquals(stats.skippedExisting, 1);
  assertEquals(wrote, false);
});

Deno.test("worker skips if annotation appears after metadata fetch", async () => {
  await clearMirrorTables();
  await bookmark("a");
  await enqueueMissingPreviewJobsForDid(DID, 10);
  const job = (await claimPreviewEnrichmentJobs(1))[0];
  let checks = 0;
  let wrote = false;

  const stats = await processPreviewEnrichmentJob(job, {
    restoreSession: () => Promise.resolve({ did: DID }),
    hasUsableAnnotation: () => Promise.resolve(++checks > 1),
    extractUrlMetadata: () => Promise.resolve({ title: "Title" }),
    writeAnnotation: () => {
      wrote = true;
      return Promise.resolve({ ok: true });
    },
  });
  assertEquals(stats.skippedExisting, 1);
  assertEquals(wrote, false);
});
