import { assert, assertEquals, assertRejects } from "@std/assert";
import { clearMirrorTables, db } from "./mirror-test-setup.ts";
import { upsertAnnotation, upsertBookmark } from "../mirror/upserts.ts";
import { readAnnotationFromPds } from "../lib/annotations.ts";
import {
  claimPreviewEnrichmentJobs,
  enqueueMissingPreviewJobsForDid,
  enqueueMissingPreviewJobsForSessionDids,
  findMissingPreviewBookmarks,
  hasUsableAnnotation,
  isUsableAnnotationRecord,
  markPreviewJobBlockedNoSession,
  markPreviewJobDone,
  markPreviewJobRetry,
} from "../lib/preview-enrichment-jobs.ts";
import {
  mergePreviewAnnotation,
  processPreviewEnrichmentJob,
  runPreviewEnrichmentTick,
} from "../lib/preview-enrichment-worker.ts";

const DID = "did:plc:previewtest";
const OTHER_DID = "did:plc:previewother";
const YT_VIDEO_URL = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
const YT_SHORT_URL = "https://youtu.be/dQw4w9WgXcQ";

async function bookmark(
  rkey: string,
  subject = `https://example.com/${rkey}`,
  did = DID,
) {
  await upsertBookmark({
    uri: `at://${did}/community.lexicon.bookmarks.bookmark/${rkey}`,
    did,
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

Deno.test("preview jobs enqueue from active session DIDs", async () => {
  await clearMirrorTables();
  await db.execute({ sql: "DELETE FROM iron_session_storage", args: [] });
  await bookmark("a");
  await bookmark("b", "https://example.com/b", OTHER_DID);
  await db.execute({
    sql:
      "INSERT INTO iron_session_storage (key, value, expires_at, created_at, updated_at) VALUES (?, '{}', ?, '', ''), (?, '{}', ?, '', '')",
    args: [
      `session:${DID}`,
      Date.now() + 60_000,
      `session:${OTHER_DID}`,
      Date.now() - 60_000,
    ],
  });

  assertEquals(await enqueueMissingPreviewJobsForSessionDids(10, 10), {
    enqueued: 1,
    dids: 1,
  });

  const rows = await db.execute({
    sql: "SELECT did FROM preview_enrichment_jobs",
    args: [],
  });
  assertEquals(
    rows.rows.map((row) => row[0]),
    [DID],
  );
  await db.execute({ sql: "DELETE FROM iron_session_storage", args: [] });
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

Deno.test("upsertAnnotation retains the preview job when clearPreviewJob is false", async () => {
  await clearMirrorTables();
  await bookmark("a");
  await enqueueMissingPreviewJobsForDid(DID, 10);
  const bookmarkUri = `at://${DID}/community.lexicon.bookmarks.bookmark/a`;

  await upsertAnnotation(
    {
      uri: `at://${DID}/com.kipclip.annotation/a`,
      did: DID,
      rkey: "a",
      cid: "bafyann",
      subject: bookmarkUri,
      title: "Partial",
    },
    { clearPreviewJob: false },
  );

  const rows = await db.execute({
    sql: "SELECT COUNT(*) FROM preview_enrichment_jobs WHERE bookmark_uri = ?",
    args: [bookmarkUri],
  });
  assertEquals(
    Number(rows.rows[0][0]),
    1,
    "the worker's own mirror write must not delete the job before completion is decided",
  );
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
    // Authoritative PDS read: no annotation yet (404).
    readAnnotation: () => Promise.resolve(null),
    extractUrlMetadata: () =>
      Promise.resolve({
        title: "Title",
        description: "Desc",
        favicon: "https://example.com/favicon.ico",
        image: "https://example.com/og.png",
      }),
    writeAnnotation: (_session, rkey, annotation, options) => {
      assertEquals(rkey, "a");
      assertEquals(
        annotation.subject,
        `at://${DID}/community.lexicon.bookmarks.bookmark/a`,
      );
      assertEquals(options?.swapRecord, undefined);
      return Promise.resolve({
        ok: true,
        uri: `at://${DID}/com.kipclip.annotation/a`,
        cid: "bafyann",
      });
    },
  });
  assertEquals(stats.success, 1);

  const rows = await db.execute({
    sql: "SELECT status FROM preview_enrichment_jobs WHERE bookmark_uri = ?",
    args: [job.bookmarkUri],
  });
  assertEquals(
    rows.rows[0][0],
    "done",
    "a complete write marks the job done instead of clearing it mid-flight",
  );
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

Deno.test("periodic enqueue does not reopen a done preview job", async () => {
  await clearMirrorTables();
  await bookmark("a");
  await enqueueMissingPreviewJobsForDid(DID, 10);
  const job = (await claimPreviewEnrichmentJobs(1))[0];
  await markPreviewJobDone(job.bookmarkUri);

  await enqueueMissingPreviewJobsForDid(DID, 10);
  const rows = await db.execute({
    sql:
      "SELECT status, attempts FROM preview_enrichment_jobs WHERE bookmark_uri = ?",
    args: [job.bookmarkUri],
  });
  assertEquals(rows.rows[0], ["done", 0]);
});

Deno.test("periodic enqueue does not reopen a failed preview job", async () => {
  await clearMirrorTables();
  await bookmark("a");
  await enqueueMissingPreviewJobsForDid(DID, 10);
  const job = (await claimPreviewEnrichmentJobs(1))[0];
  await markPreviewJobRetry(
    { ...job, attempts: 2 },
    new Error("final"),
    Date.now(),
  );

  const before = await db.execute({
    sql:
      "SELECT status, attempts, next_run_at FROM preview_enrichment_jobs WHERE bookmark_uri = ?",
    args: [job.bookmarkUri],
  });
  assertEquals(before.rows[0][0], "failed");

  await enqueueMissingPreviewJobsForDid(DID, 10);
  const after = await db.execute({
    sql:
      "SELECT status, attempts, next_run_at FROM preview_enrichment_jobs WHERE bookmark_uri = ?",
    args: [job.bookmarkUri],
  });
  assertEquals(after.rows[0], before.rows[0]);
});

Deno.test("periodic enqueue does not reopen a blocked_no_session preview job", async () => {
  await clearMirrorTables();
  await bookmark("a");
  await enqueueMissingPreviewJobsForDid(DID, 10);
  const job = (await claimPreviewEnrichmentJobs(1))[0];
  await markPreviewJobBlockedNoSession(job);

  await enqueueMissingPreviewJobsForDid(DID, 10);
  const rows = await db.execute({
    sql:
      "SELECT status, attempts FROM preview_enrichment_jobs WHERE bookmark_uri = ?",
    args: [job.bookmarkUri],
  });
  assertEquals(rows.rows[0], ["blocked_no_session", 0]);
});

Deno.test("periodic enqueue resets retry state when bookmark subject changes", async () => {
  await clearMirrorTables();
  await bookmark("a", "https://example.com/old");
  await enqueueMissingPreviewJobsForDid(DID, 10);
  const job = (await claimPreviewEnrichmentJobs(1))[0];
  await markPreviewJobRetry({ ...job, attempts: 2 }, new Error("final"), 1_000);

  await bookmark("a", "https://example.com/new");
  const before = Date.now();
  await enqueueMissingPreviewJobsForDid(DID, 10);
  const rows = await db.execute({
    sql:
      "SELECT status, attempts, next_run_at, last_error, subject FROM preview_enrichment_jobs WHERE bookmark_uri = ?",
    args: [job.bookmarkUri],
  });
  assertEquals(rows.rows[0][0], "pending");
  assertEquals(Number(rows.rows[0][1]), 0);
  const nextRunAt = Number(rows.rows[0][2]);
  assert(nextRunAt >= before && nextRunAt <= before + 5_000);
  assertEquals(rows.rows[0][3], null);
  assertEquals(rows.rows[0][4], "https://example.com/new");
});

Deno.test("periodic enqueue resets a done job when bookmark subject changes", async () => {
  await clearMirrorTables();
  await bookmark("a", "https://example.com/old");
  await enqueueMissingPreviewJobsForDid(DID, 10);
  const job = (await claimPreviewEnrichmentJobs(1))[0];
  await markPreviewJobDone(job.bookmarkUri);

  await bookmark("a", "https://example.com/new");
  await enqueueMissingPreviewJobsForDid(DID, 10);
  const rows = await db.execute({
    sql:
      "SELECT status, attempts, subject FROM preview_enrichment_jobs WHERE bookmark_uri = ?",
    args: [job.bookmarkUri],
  });
  assertEquals(rows.rows[0], ["pending", 0, "https://example.com/new"]);
});

Deno.test("periodic enqueue resets a blocked job when bookmark subject changes", async () => {
  await clearMirrorTables();
  await bookmark("a", "https://example.com/old");
  await enqueueMissingPreviewJobsForDid(DID, 10);
  const job = (await claimPreviewEnrichmentJobs(1))[0];
  await markPreviewJobBlockedNoSession(job);

  await bookmark("a", "https://example.com/new");
  await enqueueMissingPreviewJobsForDid(DID, 10);
  const rows = await db.execute({
    sql:
      "SELECT status, attempts, last_error, subject FROM preview_enrichment_jobs WHERE bookmark_uri = ?",
    args: [job.bookmarkUri],
  });
  assertEquals(rows.rows[0], ["pending", 0, null, "https://example.com/new"]);
});

Deno.test("explicit reactivation reopens a failed job, resets attempts, schedules immediate run", async () => {
  await clearMirrorTables();
  await bookmark("a");
  await enqueueMissingPreviewJobsForDid(DID, 10);
  const job = (await claimPreviewEnrichmentJobs(1))[0];
  await markPreviewJobRetry({ ...job, attempts: 2 }, new Error("final"), 1_000);
  let rows = await db.execute({
    sql:
      "SELECT status, attempts, next_run_at FROM preview_enrichment_jobs WHERE bookmark_uri = ?",
    args: [job.bookmarkUri],
  });
  assertEquals(rows.rows[0][0], "failed");
  assertEquals(Number(rows.rows[0][1]), 3);

  const before = Date.now();
  const enqueued = await enqueueMissingPreviewJobsForDid(DID, 10, {
    reactivate: true,
  });
  assertEquals(enqueued, 1);
  rows = await db.execute({
    sql:
      "SELECT status, attempts, next_run_at, last_error FROM preview_enrichment_jobs WHERE bookmark_uri = ?",
    args: [job.bookmarkUri],
  });
  assertEquals(rows.rows[0][0], "pending");
  assertEquals(Number(rows.rows[0][1]), 0);
  const nextRunAt = Number(rows.rows[0][2]);
  assert(nextRunAt >= before && nextRunAt <= before + 5_000);
  assertEquals(rows.rows[0][3], null);

  // Claim with the current time: the reactivated job's next_run_at is the
  // enqueue's Date.now(), which is always <= a later claim time. A fixed
  // `before + 1` bound was racy (the enqueue query takes a few ms, so its
  // now could land past before + 1 and the job would not be claimable).
  const claimed = await claimPreviewEnrichmentJobs(1, Date.now() + 1);
  assertEquals(claimed.map((j) => j.bookmarkUri), [job.bookmarkUri]);
  assertEquals(claimed[0].attempts, 0);
});

Deno.test("explicit reactivation reopens a blocked_no_session job with a fresh attempt", async () => {
  await clearMirrorTables();
  await bookmark("a");
  await enqueueMissingPreviewJobsForDid(DID, 10);
  const job = (await claimPreviewEnrichmentJobs(1))[0];
  await markPreviewJobBlockedNoSession(job);

  const enqueued = await enqueueMissingPreviewJobsForDid(DID, 10, {
    reactivate: true,
  });
  assertEquals(enqueued, 1);
  const rows = await db.execute({
    sql:
      "SELECT status, attempts, last_error FROM preview_enrichment_jobs WHERE bookmark_uri = ?",
    args: [job.bookmarkUri],
  });
  assertEquals(rows.rows[0], ["pending", 0, null]);
});

Deno.test("explicit reactivation leaves a done preview job unchanged", async () => {
  await clearMirrorTables();
  await bookmark("a");
  await enqueueMissingPreviewJobsForDid(DID, 10);
  const job = (await claimPreviewEnrichmentJobs(1))[0];
  await markPreviewJobDone(job.bookmarkUri);

  await enqueueMissingPreviewJobsForDid(DID, 10, { reactivate: true });
  const rows = await db.execute({
    sql:
      "SELECT status, attempts FROM preview_enrichment_jobs WHERE bookmark_uri = ?",
    args: [job.bookmarkUri],
  });
  assertEquals(rows.rows[0], ["done", 0]);
});

Deno.test("existing usable annotation prevents creating repeated preview work", async () => {
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

  assertEquals(await enqueueMissingPreviewJobsForDid(DID, 10), 0);
  const rows = await db.execute({
    sql: "SELECT COUNT(*) FROM preview_enrichment_jobs WHERE did = ?",
    args: [DID],
  });
  assertEquals(Number(rows.rows[0][0]), 0);
});

// ============================================================================
// YouTube placeholder-aware preview discovery / usability
// ============================================================================

async function annotation(
  rkey: string,
  fields: {
    title?: string;
    description?: string;
    note?: string;
    image?: string;
    favicon?: string;
  },
) {
  await upsertAnnotation({
    uri: `at://${DID}/com.kipclip.annotation/${rkey}`,
    did: DID,
    rkey,
    cid: "bafyann",
    subject: `at://${DID}/community.lexicon.bookmarks.bookmark/${rkey}`,
    title: fields.title,
    description: fields.description,
    note: fields.note,
    image: fields.image,
    favicon: fields.favicon,
  });
}

Deno.test("missing query treats a legacy '- YouTube' placeholder annotation as missing", async () => {
  await clearMirrorTables();
  await bookmark("yt", YT_VIDEO_URL);
  await annotation("yt", { title: "- YouTube" });

  const missing = await findMissingPreviewBookmarks(DID, 10);
  assertEquals(
    missing.map((b) => b.rkey),
    ["yt"],
  );
});

Deno.test("missing query includes placeholder with generic description and repairs note-bearing placeholders", async () => {
  await clearMirrorTables();
  await bookmark("generic", YT_VIDEO_URL);
  await annotation("generic", {
    title: "- YouTube",
    description: "Share your videos with friends, family, and the world.",
  });
  await bookmark("noted", YT_SHORT_URL);
  await annotation("noted", { title: "- YouTube", note: "keep my note" });

  const missing = await findMissingPreviewBookmarks(DID, 10);
  assertEquals(
    missing.map((b) => b.rkey).sort(),
    ["generic", "noted"],
    "a note alone must not protect an incomplete YouTube annotation",
  );
});

Deno.test("missing query protects meaningful annotations (custom title or custom description)", async () => {
  await clearMirrorTables();
  await bookmark("custom-title");
  await annotation("custom-title", { title: "Custom Title" });
  await bookmark("custom-desc");
  await annotation("custom-desc", {
    title: "- YouTube",
    description: "My own description",
  });

  assertEquals((await findMissingPreviewBookmarks(DID, 10)).length, 0);
});

Deno.test("hasUsableAnnotation - placeholders are not usable; complete YouTube and meaningful non-YouTube annotations are", async () => {
  await clearMirrorTables();
  await bookmark("placeholder", YT_VIDEO_URL);
  await annotation("placeholder", { title: "- YouTube" });
  assertEquals(
    await hasUsableAnnotation(
      `at://${DID}/community.lexicon.bookmarks.bookmark/placeholder`,
    ),
    false,
  );
  await clearMirrorTables();

  await bookmark("noted", YT_VIDEO_URL);
  await annotation("noted", { title: "- YouTube", note: "keep" });
  assertEquals(
    await hasUsableAnnotation(
      `at://${DID}/community.lexicon.bookmarks.bookmark/noted`,
    ),
    false,
    "a note alone must not make an incomplete YouTube annotation usable",
  );
  await clearMirrorTables();

  await bookmark("complete-yt", YT_VIDEO_URL);
  await annotation("complete-yt", {
    title: "Real Title",
    description: "Real description",
    image: "https://i.ytimg.com/vi/x/hqdefault.jpg",
    favicon: "https://www.youtube.com/favicon.ico",
  });
  assert(
    await hasUsableAnnotation(
      `at://${DID}/community.lexicon.bookmarks.bookmark/complete-yt`,
    ),
  );
  await clearMirrorTables();

  await bookmark("custom");
  await annotation("custom", { title: "Custom Title" });
  assert(
    await hasUsableAnnotation(
      `at://${DID}/community.lexicon.bookmarks.bookmark/custom`,
    ),
  );
  await clearMirrorTables();

  await bookmark("desc-only");
  await annotation("desc-only", { description: "Useful description" });
  assert(
    await hasUsableAnnotation(
      `at://${DID}/community.lexicon.bookmarks.bookmark/desc-only`,
    ),
  );
});

Deno.test(
  "hasUsableAnnotation - literal 'YouTube' title is usable when the bookmark is not a YouTube video",
  async () => {
    await clearMirrorTables();
    await bookmark("plain");
    await annotation("plain", { title: "YouTube" });
    assert(
      await hasUsableAnnotation(
        `at://${DID}/community.lexicon.bookmarks.bookmark/plain`,
      ),
      "a non-YouTube bookmark with title 'YouTube' must be protected",
    );
  },
);

Deno.test("worker repairs a legacy placeholder-only annotation with fetched metadata and finishes", async () => {
  await clearMirrorTables();
  await bookmark("yt", YT_VIDEO_URL);
  await annotation("yt", { title: "- YouTube" });
  assertEquals(await enqueueMissingPreviewJobsForDid(DID, 10), 1);

  const job = (await claimPreviewEnrichmentJobs(1))[0];
  assertEquals(job.rkey, "yt");
  let written: any = null;
  const stats = await processPreviewEnrichmentJob(job, {
    restoreSession: () =>
      Promise.resolve({ did: DID, pdsUrl: "https://pds.test" }),
    // The placeholder exists on the authoritative PDS (mirrored locally).
    readAnnotation: () =>
      Promise.resolve({
        uri: `at://${DID}/com.kipclip.annotation/yt`,
        cid: "bafyann",
        value: { subject: job.bookmarkUri, title: "- YouTube" },
      }),
    extractUrlMetadata: () =>
      Promise.resolve({
        title: "Real Video Title",
        description: "Real description",
        favicon: "https://www.youtube.com/favicon.ico",
        image: "https://i.ytimg.com/vi/x/hqdefault.jpg",
      }),
    writeAnnotation: (_session, rkey, annotationRecord) => {
      written = { rkey, annotationRecord };
      return Promise.resolve({
        ok: true,
        uri: `at://${DID}/com.kipclip.annotation/${rkey}`,
        cid: "bafyann",
      });
    },
  });
  assertEquals(stats.success, 1);
  assertEquals(written.annotationRecord.title, "Real Video Title");

  // Repaired annotation is durable, marked done, and no repeated work is
  // enqueued.
  const annotations = await db.execute({
    sql: "SELECT title FROM annotations WHERE subject = ?",
    args: [job.bookmarkUri],
  });
  assertEquals(annotations.rows[0][0], "Real Video Title");
  const jobRows = await db.execute({
    sql: "SELECT status FROM preview_enrichment_jobs WHERE bookmark_uri = ?",
    args: [job.bookmarkUri],
  });
  assertEquals(jobRows.rows[0][0], "done");
  assertEquals(await enqueueMissingPreviewJobsForDid(DID, 10), 0);
});

Deno.test("worker persists available fields and applies bounded retry when the watch page has no usable description (note preserved)", async () => {
  await clearMirrorTables();
  await bookmark("yt", YT_VIDEO_URL);
  // Mirror placeholder exists BEFORE enqueueing so the job row survives
  // (a test-side upsert after claiming would delete the row like any
  // webhook write; the worker's own mirror write must NOT).
  await annotation("yt", { title: "- YouTube", note: "keep my note" });
  assertEquals(await enqueueMissingPreviewJobsForDid(DID, 10), 1);
  const job = (await claimPreviewEnrichmentJobs(1))[0];

  // Fetch yields title/image/favicon but NO description (the watch page was
  // a 404/consent wall/live stream). The write still persists the available
  // fields and keeps the note; the job is NOT marked done — it retries with
  // bounded backoff instead of looping forever.
  let written: any = null;
  const stats = await processPreviewEnrichmentJob(job, {
    restoreSession: () =>
      Promise.resolve({ did: DID, pdsUrl: "https://pds.test" }),
    readAnnotation: () =>
      Promise.resolve({
        uri: `at://${DID}/com.kipclip.annotation/${job.rkey}`,
        cid: "bafyann",
        value: {
          subject: job.bookmarkUri,
          title: "- YouTube",
          note: "keep my note",
        },
      }),
    extractUrlMetadata: () =>
      Promise.resolve({
        title: "Real Video Title",
        favicon: "https://www.youtube.com/favicon.ico",
        image: "https://i.ytimg.com/vi/x/hqdefault.jpg",
      }),
    writeAnnotation: (_session, rkey, annotationRecord) => {
      written = { rkey, annotationRecord };
      return Promise.resolve({
        ok: true,
        uri: `at://${DID}/com.kipclip.annotation/${rkey}`,
        cid: "bafyann",
      });
    },
  });
  assertEquals(stats.success, 0);
  assertEquals(stats.retry, 1, "no-description writes must not mark done");
  assertEquals(written.annotationRecord.title, "Real Video Title");
  assertEquals(written.annotationRecord.note, "keep my note");
  const annotations = await db.execute({
    sql: "SELECT note, title FROM annotations WHERE subject = ?",
    args: [job.bookmarkUri],
  });
  assertEquals(annotations.rows[0][0], "keep my note");
  assertEquals(annotations.rows[0][1], "Real Video Title");
  const jobRows = await db.execute({
    sql:
      "SELECT status, attempts FROM preview_enrichment_jobs WHERE bookmark_uri = ?",
    args: [job.bookmarkUri],
  });
  assertEquals(jobRows.rows[0], ["pending", 1]);
});

Deno.test("worker treats an empty metadata result as retryable, not a success", async () => {
  await clearMirrorTables();
  await bookmark("yt");
  await enqueueMissingPreviewJobsForDid(DID, 10);
  const job = (await claimPreviewEnrichmentJobs(1))[0];

  let wrote = false;
  const stats = await processPreviewEnrichmentJob(job, {
    restoreSession: () =>
      Promise.resolve({ did: DID, pdsUrl: "https://pds.test" }),
    extractUrlMetadata: () => Promise.resolve({}),
    writeAnnotation: () => {
      wrote = true;
      return Promise.resolve({ ok: true });
    },
  });
  assertEquals(stats.success, 0);
  assertEquals(stats.retry, 1);
  assertEquals(wrote, false, "empty metadata must not be persisted");

  const rows = await db.execute({
    sql:
      "SELECT status, attempts FROM preview_enrichment_jobs WHERE bookmark_uri = ?",
    args: [job.bookmarkUri],
  });
  assertEquals(rows.rows[0][0], "pending");
  assertEquals(Number(rows.rows[0][1]), 1);
});

// ============================================================================
// Default detection agreement: SQL enqueue query vs hasUsableAnnotation
// ============================================================================

Deno.test(
  "missing query treats lowercase/whitespace default variants as placeholders (YouTube subjects)",
  async () => {
    await clearMirrorTables();
    await bookmark("mixed-case", YT_VIDEO_URL);
    await annotation("mixed-case", { title: "  -  yOuTuBe  " });
    await bookmark("spacey", YT_SHORT_URL);
    await annotation("spacey", {
      title: "  -  YouTube  ",
      description: " share  your videos with friends, family, and the world. ",
    });
    await bookmark("lower-title", YT_VIDEO_URL);
    await annotation("lower-title", { title: "youtube" });
    await bookmark("lower-desc", YT_VIDEO_URL);
    await annotation("lower-desc", {
      description:
        "enjoy the videos and music you love, upload original content, and share it all with friends, family, and the world on youtube.",
    });

    const missing = await findMissingPreviewBookmarks(DID, 10);
    assertEquals(
      missing.map((b) => b.rkey).sort(),
      ["lower-desc", "lower-title", "mixed-case", "spacey"],
    );
  },
);

Deno.test(
  "hasUsableAnnotation agrees with the enqueue query on lowercase/whitespace variants",
  async () => {
    await clearMirrorTables();
    await bookmark("spacey", YT_SHORT_URL);
    await annotation("spacey", { title: "  -  YouTube  " });
    assertEquals(
      await hasUsableAnnotation(
        `at://${DID}/community.lexicon.bookmarks.bookmark/spacey`,
      ),
      false,
      "SQL considers it missing, so JS usability must agree it is not usable",
    );

    await clearMirrorTables();
    await bookmark("lower", YT_VIDEO_URL);
    await annotation("lower", { title: "youtube" });
    assertEquals(
      await hasUsableAnnotation(
        `at://${DID}/community.lexicon.bookmarks.bookmark/lower`,
      ),
      false,
    );

    await clearMirrorTables();
    await bookmark("custom", YT_SHORT_URL);
    await annotation("custom", { title: "  My Video  ", description: "" });
    assertEquals(
      await hasUsableAnnotation(
        `at://${DID}/community.lexicon.bookmarks.bookmark/custom`,
      ),
      false,
      "a YouTube title without a description is incomplete, and the SQL query must discover it",
    );
  },
);

Deno.test(
  "missing query treats a literal 'YouTube' title on a non-YouTube bookmark as meaningful",
  async () => {
    await clearMirrorTables();
    await bookmark("plain");
    await annotation("plain", { title: "YouTube" });
    await bookmark("yt", YT_VIDEO_URL);
    await annotation("yt", { title: "YouTube" });

    const missing = await findMissingPreviewBookmarks(DID, 10);
    assertEquals(
      missing.map((b) => b.rkey),
      ["yt"],
      "only the actual YouTube video bookmark is a placeholder",
    );
  },
);

Deno.test(
  "missing query still repairs an empty-annotation bookmark regardless of URL type",
  async () => {
    await clearMirrorTables();
    await bookmark("plain", "https://example.com/no-annotation");
    await bookmark("yt", YT_VIDEO_URL);
    // Legacy broken annotations: subject+createdAt only.
    await upsertAnnotation({
      uri: `at://${DID}/com.kipclip.annotation/plain`,
      did: DID,
      rkey: "plain",
      cid: "bafyann",
      subject: `at://${DID}/community.lexicon.bookmarks.bookmark/plain`,
    });

    const missing = await findMissingPreviewBookmarks(DID, 10);
    assertEquals(
      missing.map((b) => b.rkey).sort(),
      ["plain", "yt"],
    );
  },
);

// ============================================================================
// Exact YouTube subject discovery (hostname equality, explicit ports)
// ============================================================================

Deno.test("missing query selects YouTube subjects with an explicit host port", async () => {
  await clearMirrorTables();
  await bookmark("port-watch", "https://youtube.com:8443/watch?v=dQw4w9WgXcQ");
  await annotation("port-watch", { title: "- YouTube" });
  await bookmark(
    "port-shorts",
    "http://www.youtube.com:8080/shorts/dQw4w9WgXcQ",
  );
  await annotation("port-shorts", { title: "- YouTube" });
  await bookmark("port-live", "https://m.youtube.com:443/live/dQw4w9WgXcQ");
  await annotation("port-live", { title: "- YouTube" });
  await bookmark("port-youtu", "https://youtu.be:443/dQw4w9WgXcQ");
  await annotation("port-youtu", { title: "- YouTube" });

  const missing = await findMissingPreviewBookmarks(DID, 25);
  assertEquals(
    missing.map((b) => b.rkey).sort(),
    ["port-live", "port-shorts", "port-watch", "port-youtu"],
    "explicit :port forms are recognized YouTube subjects and must be discovered",
  );
});

Deno.test("missing query rejects obvious non-YouTube hostname/path substring matches", async () => {
  await clearMirrorTables();
  await bookmark("music", "https://music.youtube.com/watch?v=dQw4w9WgXcQ");
  await annotation("music", { title: "- YouTube" });
  await bookmark(
    "attacker",
    "https://evil.example/youtube.com/watch?v=dQw4w9WgXcQ",
  );
  await annotation("attacker", { title: "- YouTube" });
  await bookmark(
    "path-youtube",
    "https://example.com/foo/youtube.com/shorts/dQw4w9WgXcQ",
  );
  await annotation("path-youtube", { title: "- YouTube" });
  await bookmark(
    "lookalike-host",
    "https://youtube.com.evil.example/watch?v=dQw4w9WgXcQ",
  );
  await annotation("lookalike-host", { title: "- YouTube" });

  assertEquals(
    await findMissingPreviewBookmarks(DID, 10),
    [],
    "substring matches on non-YouTube hosts must not be treated as YouTube subjects",
  );
  // The JS semantic gate agrees: none of these are recognized YouTube videos,
  // so their '- YouTube' titles are meaningful and must be protected.
  for (const rkey of ["music", "attacker", "path-youtube", "lookalike-host"]) {
    assert(
      await hasUsableAnnotation(
        `at://${DID}/community.lexicon.bookmarks.bookmark/${rkey}`,
      ),
      `non-YouTube subject ${rkey} must stay usable`,
    );
  }
});

Deno.test("missing query keeps every real production YouTube form discoverable", async () => {
  await clearMirrorTables();
  const subjects: [string, string][] = [
    ["www-watch", "https://www.youtube.com/watch?v=dQw4w9WgXcQ"],
    ["bare-watch", "https://youtube.com/watch?v=dQw4w9WgXcQ"],
    [
      "m-watch",
      "http://m.youtube.com/watch?feature=player_embedded&v=dQw4w9WgXcQ",
    ],
    ["ytbe", "https://youtu.be/dQw4w9WgXcQ?si=abc"],
    ["nocookie-watch", "https://www.youtube-nocookie.com/watch?v=dQw4w9WgXcQ"],
    ["shorts", "https://youtube.com/shorts/dQw4w9WgXcQ"],
    ["live", "https://www.youtube.com/live/dQw4w9WgXcQ"],
    ["embed", "https://youtube-nocookie.com/embed/dQw4w9WgXcQ"],
    ["vpath", "https://www.youtube.com/v/dQw4w9WgXcQ"],
    [
      "tracked",
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PL123&index=2",
    ],
    ["fragment", "https://www.youtube.com/watch?v=dQw4w9WgXcQ#t=30"],
    [
      "http-watch",
      "http://www.youtube.com/watch?feature=youtu.be&v=2QUUtjdOubE",
    ],
  ];
  for (const [rkey, subject] of subjects) {
    await bookmark(rkey, subject);
    await annotation(rkey, {
      title: "- YouTube",
      description: "Share your videos with friends, family, and the world.",
    });
  }
  const missing = await findMissingPreviewBookmarks(DID, 25);
  assertEquals(
    missing.map((b) => b.rkey).sort(),
    subjects.map(([r]) => r).sort(),
    "every real production YouTube subject shape must stay discoverable",
  );
});

Deno.test("hasUsableAnnotation agrees on explicit-port subjects (JS semantic gate)", async () => {
  await clearMirrorTables();
  await bookmark("port-watch", "https://youtube.com:8443/watch?v=dQw4w9WgXcQ");
  await annotation("port-watch", { title: "- YouTube" });
  assertEquals(
    await hasUsableAnnotation(
      `at://${DID}/community.lexicon.bookmarks.bookmark/port-watch`,
    ),
    false,
    "an explicit-port YouTube subject is a YouTube subject: placeholder title is not usable",
  );
});

// ============================================================================
// Worker completion boundary: no usable description → bounded retry, not done
// ============================================================================

Deno.test(
  "worker retains the job and applies bounded retry when the merged annotation stays incomplete (no usable description)",
  async () => {
    await clearMirrorTables();
    // Mirror placeholder exists BEFORE enqueueing so the job row survives.
    await bookmark("yt", YT_VIDEO_URL);
    await annotation("yt", { title: "- YouTube" });
    assertEquals(await enqueueMissingPreviewJobsForDid(DID, 10), 1);
    const job = (await claimPreviewEnrichmentJobs(1))[0];
    assertEquals(job.rkey, "yt");

    // Watch page has no usable description (404/consent/bot wall/live
    // stream): only title/image/favicon are obtained.
    let written: any = null;
    const stats = await processPreviewEnrichmentJob(job, {
      restoreSession: () =>
        Promise.resolve({ did: DID, pdsUrl: "https://pds.test" }),
      readAnnotation: () =>
        Promise.resolve({
          uri: `at://${DID}/com.kipclip.annotation/${job.rkey}`,
          cid: "bafyuser",
          value: { subject: job.bookmarkUri, title: "- YouTube" },
        }),
      extractUrlMetadata: () =>
        Promise.resolve({
          title: "Real Title",
          favicon: "https://www.youtube.com/favicon.ico",
          image: "https://i.ytimg.com/vi/x/hqdefault.jpg",
        }),
      writeAnnotation: (_session, _rkey, annotationRecord) => {
        written = annotationRecord;
        return Promise.resolve({
          ok: true,
          uri: `at://${DID}/com.kipclip.annotation/${job.rkey}`,
          cid: "bafyann",
        });
      },
    });
    assertEquals(
      stats.success,
      0,
      "an incomplete annotation must not be marked done after the write",
    );
    assertEquals(
      stats.retry,
      1,
      "an incomplete annotation must keep the job with bounded retry",
    );
    assertEquals(written.title, "Real Title");
    assertEquals(written.description, undefined);

    // Available fields are persisted once for this attempt (in the mirror
    // via the worker's own upsert, and on the PDS via the write above).
    const mirror = await db.execute({
      sql:
        "SELECT title, favicon, image, description FROM annotations WHERE subject = ?",
      args: [job.bookmarkUri],
    });
    assertEquals(mirror.rows[0], [
      "Real Title",
      "https://www.youtube.com/favicon.ico",
      "https://i.ytimg.com/vi/x/hqdefault.jpg",
      null,
    ]);

    // The job is RETAINED (the worker's own mirror upsert must not delete it
    // before completion is decided) with bounded backoff: attempt 1 → pending.
    const rows = await db.execute({
      sql:
        "SELECT status, attempts, next_run_at FROM preview_enrichment_jobs WHERE bookmark_uri = ?",
      args: [job.bookmarkUri],
    });
    assertEquals(rows.rows[0][0], "pending");
    assertEquals(Number(rows.rows[0][1]), 1);
    const DAY = 24 * 60 * 60 * 1000;
    const nextRunAt = Number(rows.rows[0][2]);
    assert(
      Math.abs(nextRunAt - (Date.now() + DAY)) < 2_000,
      "attempt 1 schedules the next run one day out",
    );
  },
);

// ============================================================================
// Retroactive YouTube repair: incomplete existing annotations
// ============================================================================

Deno.test(
  "retroactive discovery: meaningful YouTube title with missing image/description is incomplete",
  async () => {
    await clearMirrorTables();
    await bookmark("yt", YT_VIDEO_URL);
    await annotation("yt", { title: "Real Video Title" });

    const missing = await findMissingPreviewBookmarks(DID, 10);
    assertEquals(
      missing.map((b) => b.rkey),
      ["yt"],
      "a valid YouTube title alone must not prevent thumbnail/description enrichment",
    );
    assertEquals(await enqueueMissingPreviewJobsForDid(DID, 10), 1);
    assertEquals(
      await hasUsableAnnotation(
        `at://${DID}/community.lexicon.bookmarks.bookmark/yt`,
      ),
      false,
    );
  },
);

Deno.test("retroactive discovery: fully enriched YouTube annotation is skipped", async () => {
  await clearMirrorTables();
  await bookmark("full", YT_VIDEO_URL);
  await annotation("full", {
    title: "Real Title",
    description: "Real description",
    image: "https://i.ytimg.com/vi/x/hqdefault.jpg",
    favicon: "https://www.youtube.com/favicon.ico",
  });
  assertEquals(await findMissingPreviewBookmarks(DID, 10), []);
  assertEquals(await enqueueMissingPreviewJobsForDid(DID, 10), 0);
  assert(
    await hasUsableAnnotation(
      `at://${DID}/community.lexicon.bookmarks.bookmark/full`,
    ),
  );

  // A stale pending job claimed before completion must be skipped without
  // writing once the annotation is fully enriched.
  await bookmark("yt", YT_VIDEO_URL);
  await enqueueMissingPreviewJobsForDid(DID, 10);
  const job = (await claimPreviewEnrichmentJobs(1))[0];
  await annotation("yt", {
    title: "Real Title",
    description: "Real description",
    image: "https://i.ytimg.com/vi/x/hqdefault.jpg",
    favicon: "https://www.youtube.com/favicon.ico",
  });
  let wrote = false;
  const stats = await processPreviewEnrichmentJob(job, {
    restoreSession: () => Promise.resolve({ did: DID }),
    extractUrlMetadata: () =>
      Promise.resolve({
        title: "Another Title",
        image: "https://i.ytimg.com/vi/x/mqdefault.jpg",
      }),
    writeAnnotation: () => {
      wrote = true;
      return Promise.resolve({ ok: true });
    },
  });
  assertEquals(stats.skippedExisting, 1);
  assertEquals(wrote, false);
});

Deno.test("retroactive discovery: non-YouTube meaningful partial metadata stays protected", async () => {
  await clearMirrorTables();
  await bookmark("plain");
  await annotation("plain", { title: "Custom Title" });

  assertEquals(await findMissingPreviewBookmarks(DID, 10), []);
  assertEquals(await enqueueMissingPreviewJobsForDid(DID, 10), 0);
  assert(
    await hasUsableAnnotation(
      `at://${DID}/community.lexicon.bookmarks.bookmark/plain`,
    ),
    "a non-YouTube bookmark must not be selected merely because it lacks an image/favicon",
  );

  // A stale pending job is skipped without writing.
  await bookmark("note", "https://example.com/note");
  await enqueueMissingPreviewJobsForDid(DID, 10);
  const job = (await claimPreviewEnrichmentJobs(1))[0];
  await annotation("note", { note: "keep", title: "Custom Title" });
  let wrote = false;
  const stats = await processPreviewEnrichmentJob(job, {
    restoreSession: () => Promise.resolve({ did: DID }),
    extractUrlMetadata: () =>
      Promise.resolve({
        title: "Fetched",
        image: "https://example.com/og.png",
      }),
    writeAnnotation: () => {
      wrote = true;
      return Promise.resolve({ ok: true });
    },
  });
  assertEquals(stats.skippedExisting, 1);
  assertEquals(wrote, false);
});

Deno.test("worker repairs a note-bearing partial YouTube annotation preserving note/title/description", async () => {
  await clearMirrorTables();
  await bookmark("yt", YT_VIDEO_URL);
  assertEquals(await enqueueMissingPreviewJobsForDid(DID, 10), 1);
  const job = (await claimPreviewEnrichmentJobs(1))[0];
  assertEquals(job.rkey, "yt");
  await annotation("yt", {
    title: "My Title",
    description: "My description",
    note: "keep my note",
  });

  let written: any = null;
  const stats = await processPreviewEnrichmentJob(job, {
    restoreSession: () =>
      Promise.resolve({ did: DID, pdsUrl: "https://pds.test" }),
    // The user's note/title/description exist on the authoritative PDS (the
    // mirror row simply mirrors them).
    readAnnotation: () =>
      Promise.resolve({
        uri: `at://${DID}/com.kipclip.annotation/${job.rkey}`,
        cid: "bafyuser",
        value: {
          subject: job.bookmarkUri,
          note: "keep my note",
          title: "My Title",
          description: "My description",
        },
      }),
    extractUrlMetadata: () =>
      Promise.resolve({
        title: "Fetched Title",
        description: "Fetched description",
        favicon: "https://www.youtube.com/favicon.ico",
        image: "https://i.ytimg.com/vi/x/hqdefault.jpg",
      }),
    writeAnnotation: (_session, _rkey, annotationRecord) => {
      written = annotationRecord;
      return Promise.resolve({
        ok: true,
        uri: `at://${DID}/com.kipclip.annotation/${job.rkey}`,
        cid: "bafyann",
      });
    },
  });
  assertEquals(stats.success, 1);
  assertEquals(written.note, "keep my note");
  assertEquals(
    written.title,
    "My Title",
    "meaningful title must not be overwritten",
  );
  assertEquals(
    written.description,
    "My description",
    "meaningful description must not be overwritten",
  );
  assertEquals(written.image, "https://i.ytimg.com/vi/x/hqdefault.jpg");
  assertEquals(written.favicon, "https://www.youtube.com/favicon.ico");

  // The mirror reflects the repaired fields and the preserved note.
  const rows = await db.execute({
    sql:
      "SELECT note, title, description, image FROM annotations WHERE subject = ?",
    args: [job.bookmarkUri],
  });
  assertEquals(rows.rows[0], [
    "keep my note",
    "My Title",
    "My description",
    "https://i.ytimg.com/vi/x/hqdefault.jpg",
  ]);
  // Repaired annotation is now complete: no repeated work.
  assertEquals(await enqueueMissingPreviewJobsForDid(DID, 10), 0);
});

Deno.test("worker fills missing preview fields into a title-only YouTube annotation without replacing the title", async () => {
  await clearMirrorTables();
  await bookmark("yt", YT_VIDEO_URL);
  await enqueueMissingPreviewJobsForDid(DID, 10);
  const job = (await claimPreviewEnrichmentJobs(1))[0];
  await annotation("yt", { title: "Real Video Title" });

  let written: any = null;
  const stats = await processPreviewEnrichmentJob(job, {
    restoreSession: () =>
      Promise.resolve({ did: DID, pdsUrl: "https://pds.test" }),
    readAnnotation: () =>
      Promise.resolve({
        uri: `at://${DID}/com.kipclip.annotation/${job.rkey}`,
        cid: "bafyuser",
        value: { subject: job.bookmarkUri, title: "Real Video Title" },
      }),
    extractUrlMetadata: () =>
      Promise.resolve({
        title: "Fetched Title",
        description: "Fetched description",
        favicon: "https://www.youtube.com/favicon.ico",
        image: "https://i.ytimg.com/vi/x/hqdefault.jpg",
      }),
    writeAnnotation: (_session, _rkey, annotationRecord) => {
      written = annotationRecord;
      return Promise.resolve({ ok: true });
    },
  });
  assertEquals(stats.success, 1);
  assertEquals(written.title, "Real Video Title");
  assertEquals(written.description, "Fetched description");
  assertEquals(written.image, "https://i.ytimg.com/vi/x/hqdefault.jpg");
  assertEquals(written.favicon, "https://www.youtube.com/favicon.ico");
});

Deno.test("worker replaces default YouTube fields with fetched values", async () => {
  await clearMirrorTables();
  await bookmark("yt", YT_VIDEO_URL);
  await enqueueMissingPreviewJobsForDid(DID, 10);
  const job = (await claimPreviewEnrichmentJobs(1))[0];
  await annotation("yt", {
    title: "- YouTube",
    description: "Share your videos with friends, family, and the world.",
  });

  let written: any = null;
  const stats = await processPreviewEnrichmentJob(job, {
    restoreSession: () =>
      Promise.resolve({ did: DID, pdsUrl: "https://pds.test" }),
    readAnnotation: () =>
      Promise.resolve({
        uri: `at://${DID}/com.kipclip.annotation/${job.rkey}`,
        cid: "bafyuser",
        value: {
          subject: job.bookmarkUri,
          title: "- YouTube",
          description: "Share your videos with friends, family, and the world.",
        },
      }),
    extractUrlMetadata: () =>
      Promise.resolve({
        title: "Fetched Title",
        description: "Fetched description",
        favicon: "https://www.youtube.com/favicon.ico",
        image: "https://i.ytimg.com/vi/x/hqdefault.jpg",
      }),
    writeAnnotation: (_session, _rkey, annotationRecord) => {
      written = annotationRecord;
      return Promise.resolve({ ok: true });
    },
  });
  assertEquals(stats.success, 1);
  assertEquals(written.title, "Fetched Title");
  assertEquals(written.description, "Fetched description");
  assertEquals(written.image, "https://i.ytimg.com/vi/x/hqdefault.jpg");
});

Deno.test("worker leaves an existing partial annotation untouched when metadata is empty", async () => {
  await clearMirrorTables();
  await bookmark("yt", YT_VIDEO_URL);
  await enqueueMissingPreviewJobsForDid(DID, 10);
  const job = (await claimPreviewEnrichmentJobs(1))[0];
  await annotation("yt", { title: "Real Video Title" });

  let wrote = false;
  const stats = await processPreviewEnrichmentJob(job, {
    restoreSession: () =>
      Promise.resolve({ did: DID, pdsUrl: "https://pds.test" }),
    extractUrlMetadata: () => Promise.resolve({}),
    writeAnnotation: () => {
      wrote = true;
      return Promise.resolve({ ok: true });
    },
  });
  assertEquals(stats.success, 0);
  assertEquals(stats.retry, 1);
  assertEquals(wrote, false, "empty metadata must not be persisted");
  const rows = await db.execute({
    sql: "SELECT title, image FROM annotations WHERE subject = ?",
    args: [job.bookmarkUri],
  });
  assertEquals(rows.rows[0][0], "Real Video Title");
  assertEquals(rows.rows[0][1], null);
});

Deno.test("worker preserves createdAt supplied by the annotation read seam", async () => {
  await clearMirrorTables();
  await bookmark("yt", YT_VIDEO_URL);
  await enqueueMissingPreviewJobsForDid(DID, 10);
  const job = (await claimPreviewEnrichmentJobs(1))[0];

  let written: any = null;
  let swapSeen: string | undefined = "unset";
  const stats = await processPreviewEnrichmentJob(job, {
    restoreSession: () =>
      Promise.resolve({ did: DID, pdsUrl: "https://pds.test" }),
    // Authoritative PDS record carries the user's title and createdAt; the
    // mirror stores neither.
    readAnnotation: () =>
      Promise.resolve({
        uri: `at://${DID}/com.kipclip.annotation/${job.rkey}`,
        cid: "bafyuser",
        value: {
          subject: job.bookmarkUri,
          title: "My Title",
          createdAt: "2024-01-01T00:00:00.000Z",
        },
      }),
    extractUrlMetadata: () =>
      Promise.resolve({
        title: "Fetched",
        description: "Fetched description",
        favicon: "https://www.youtube.com/favicon.ico",
        image: "https://i.ytimg.com/vi/x/hqdefault.jpg",
      }),
    writeAnnotation: (_session, _rkey, annotationRecord, options) => {
      written = annotationRecord;
      swapSeen = options?.swapRecord;
      return Promise.resolve({ ok: true });
    },
  });
  assertEquals(stats.success, 1);
  assertEquals(written.createdAt, "2024-01-01T00:00:00.000Z");
  assertEquals(written.title, "My Title");
  assertEquals(
    swapSeen,
    "bafyuser",
    "the fetched PDS CID must be passed as swapRecord",
  );
});

// ============================================================================
// mergePreviewAnnotation: fill-only merge safety
// ============================================================================

Deno.test("mergePreviewAnnotation - fills only missing fields and preserves user data", () => {
  const merged = mergePreviewAnnotation(
    {
      subject: "x",
      note: "keep note",
      title: "My Title",
      description: "My desc",
    },
    {
      title: "Fetched",
      description: "Fetched desc",
      favicon: "https://www.youtube.com/favicon.ico",
      image: "https://i.ytimg.com/vi/x/hqdefault.jpg",
    },
    "at://did:plc:x/community.lexicon.bookmarks.bookmark/x",
    YT_VIDEO_URL,
    "2026-01-01T00:00:00.000Z",
  );
  assertEquals(
    merged.subject,
    "at://did:plc:x/community.lexicon.bookmarks.bookmark/x",
  );
  assertEquals(merged.note, "keep note");
  assertEquals(merged.title, "My Title");
  assertEquals(merged.description, "My desc");
  assertEquals(merged.favicon, "https://www.youtube.com/favicon.ico");
  assertEquals(merged.image, "https://i.ytimg.com/vi/x/hqdefault.jpg");
});

Deno.test("mergePreviewAnnotation - replaces known default fields with fetched values", () => {
  const merged = mergePreviewAnnotation(
    {
      subject: "x",
      title: "- YouTube",
      description: "Share your videos with friends, family, and the world.",
    },
    {
      title: "Fetched",
      description: "Fetched desc",
      favicon: "https://www.youtube.com/favicon.ico",
      image: "https://i.ytimg.com/vi/x/hqdefault.jpg",
    },
    "at://did:plc:x/community.lexicon.bookmarks.bookmark/x",
    YT_VIDEO_URL,
  );
  assertEquals(merged.title, "Fetched");
  assertEquals(merged.description, "Fetched desc");
});

Deno.test("mergePreviewAnnotation - does not delete existing fields when the fetch lacks description/image", () => {
  const merged = mergePreviewAnnotation(
    {
      subject: "x",
      title: "My Title",
      description: "My desc",
      favicon: "existing-fav",
      image: "existing-img",
    },
    { title: "Fetched" },
    "at://did:plc:x/community.lexicon.bookmarks.bookmark/x",
    YT_VIDEO_URL,
  );
  assertEquals(merged.title, "My Title");
  assertEquals(merged.description, "My desc");
  assertEquals(merged.favicon, "existing-fav");
  assertEquals(merged.image, "existing-img");
});

Deno.test("mergePreviewAnnotation - preserves existing createdAt and stamps one for fresh records", () => {
  const merged = mergePreviewAnnotation(
    { subject: "x", title: "My Title", createdAt: "2024-01-01T00:00:00.000Z" },
    { title: "Fetched", image: "img" },
    "at://did:plc:x/community.lexicon.bookmarks.bookmark/x",
    YT_VIDEO_URL,
    "2026-01-01T00:00:00.000Z",
  );
  assertEquals(merged.createdAt, "2024-01-01T00:00:00.000Z");

  const fresh = mergePreviewAnnotation(
    null,
    { title: "T" },
    "at://did:plc:x/community.lexicon.bookmarks.bookmark/x",
    YT_VIDEO_URL,
    "2026-01-01T00:00:00.000Z",
  );
  assertEquals(fresh.createdAt, "2026-01-01T00:00:00.000Z");
  assertEquals(fresh.title, "T");
});

Deno.test("mergePreviewAnnotation - non-YouTube existing fields are treated as meaningful", () => {
  const merged = mergePreviewAnnotation(
    { subject: "x", title: "YouTube", note: "keep" },
    { title: "Fetched", description: "d", favicon: "f", image: "i" },
    "at://did:plc:x/community.lexicon.bookmarks.bookmark/x",
    "https://example.com/page",
  );
  assertEquals(
    merged.title,
    "YouTube",
    "a literal 'YouTube' title on a non-YouTube bookmark is meaningful",
  );
  assertEquals(merged.note, "keep");
});

// ============================================================================
// PDS-authoritative merge base (no mirror, no data loss, swapRecord)
// ============================================================================

/** A session whose makeRequest answers only the given getRecord responses. */
function mockPdsSession(
  responder: () => Promise<Response> | Response,
): { did: string; pdsUrl: string; makeRequest: () => Promise<Response> } {
  return {
    did: DID,
    pdsUrl: "https://pds.test",
    makeRequest: () => Promise.resolve(responder()),
  };
}

Deno.test(
  "readAnnotationFromPds - 404 is no annotation, success returns record+cid, failures throw",
  async () => {
    const none = mockPdsSession(() =>
      new Response("not found", { status: 404 })
    );
    assertEquals(await readAnnotationFromPds(none, "a"), null);

    const found = mockPdsSession(() =>
      new Response(
        JSON.stringify({
          uri: `at://${DID}/com.kipclip.annotation/a`,
          cid: "bafypds",
          value: { subject: "at://x/bookmark/a", title: "T", note: "n" },
        }),
        { status: 200 },
      )
    );
    const record = await readAnnotationFromPds(found, "a");
    assertEquals(record?.cid, "bafypds");
    assertEquals(record?.value.note, "n");
    assertEquals(record?.value.title, "T");

    const failing = mockPdsSession(() =>
      new Response("Service Unavailable", { status: 503 })
    );
    await assertRejects(() => readAnnotationFromPds(failing, "a"), Error);

    const networkError = mockPdsSession(() => {
      throw new TypeError("connection refused");
    });
    await assertRejects(() => readAnnotationFromPds(networkError, "a"), Error);
  },
);

Deno.test(
  "readAnnotationFromPds - 400 RecordNotFound is no annotation, other 400s throw",
  async () => {
    // The authoritative PDS answers a missing record with HTTP 400 and the
    // XRPC error code RecordNotFound (the com.kipclip.annotation PDS does not
    // return 404). That must be the same "no annotation" answer as a 404:
    // the preview worker then creates the annotation instead of retrying.
    const missing = mockPdsSession(() =>
      new Response(
        JSON.stringify({
          error: "RecordNotFound",
          message: "Could not locate record: com.kipclip.annotation/a",
        }),
        { status: 400 },
      )
    );
    assertEquals(await readAnnotationFromPds(missing, "a"), null);

    // A 400 with any OTHER error code (or a non-JSON body) is a genuine PDS
    // failure: it must keep throwing so the caller retries instead of
    // assuming the annotation is absent.
    const invalid = mockPdsSession(() =>
      new Response(
        JSON.stringify({ error: "InvalidRequest", message: "Bad repo" }),
        { status: 400 },
      )
    );
    await assertRejects(() => readAnnotationFromPds(invalid, "a"), Error);

    const textBody = mockPdsSession(() =>
      new Response("Bad Request", { status: 400 })
    );
    await assertRejects(() => readAnnotationFromPds(textBody, "a"), Error);

    // A RecordNotFound-shaped body on a different status stays retryable too.
    const wrongStatus = mockPdsSession(() =>
      new Response(
        JSON.stringify({ error: "RecordNotFound", message: "gone" }),
        { status: 401 },
      )
    );
    await assertRejects(() => readAnnotationFromPds(wrongStatus, "a"), Error);
  },
);

Deno.test(
  "worker merges from the authoritative PDS record, preserving all fields and createdAt, and passes the PDS CID as swapRecord",
  async () => {
    await clearMirrorTables();
    // Deliberately NO mirror annotation: the merge base must come from the
    // PDS read, not the (missing/stale) mirror.
    await bookmark("yt", YT_VIDEO_URL);
    assertEquals(await enqueueMissingPreviewJobsForDid(DID, 10), 1);
    const job = (await claimPreviewEnrichmentJobs(1))[0];
    assertEquals(job.rkey, "yt");

    let written: any = null;
    let swapSeen: string | undefined = "unset";
    const stats = await processPreviewEnrichmentJob(job, {
      restoreSession: () =>
        Promise.resolve({ did: DID, pdsUrl: "https://pds.test" }),
      readAnnotation: () =>
        Promise.resolve({
          uri: `at://${DID}/com.kipclip.annotation/yt`,
          cid: "bafyuser",
          value: {
            subject: job.bookmarkUri,
            note: "user note",
            title: "User Title",
            description: "User description",
            image: "https://user.example/og.png",
            createdAt: "2021-06-01T00:00:00.000Z",
          },
        }),
      extractUrlMetadata: () =>
        Promise.resolve({
          title: "Fetched Title",
          description: "Fetched description",
          favicon: "https://www.youtube.com/favicon.ico",
          image: "https://i.ytimg.com/vi/x/hqdefault.jpg",
        }),
      writeAnnotation: (_session, _rkey, annotationRecord, options) => {
        written = annotationRecord;
        swapSeen = options?.swapRecord;
        return Promise.resolve({ ok: true });
      },
    });
    assertEquals(stats.success, 1);
    assertEquals(written.note, "user note");
    assertEquals(
      written.title,
      "User Title",
      "a meaningful PDS title must never be overwritten by fetched metadata",
    );
    assertEquals(
      written.description,
      "User description",
      "a meaningful PDS description must never be overwritten",
    );
    assertEquals(
      written.image,
      "https://user.example/og.png",
      "an existing PDS image must never be overwritten",
    );
    assertEquals(written.favicon, "https://www.youtube.com/favicon.ico");
    assertEquals(
      written.createdAt,
      "2021-06-01T00:00:00.000Z",
      "the PDS record's createdAt must survive the merge",
    );
    assertEquals(
      swapSeen,
      "bafyuser",
      "the fetched PDS CID must be passed as swapRecord so a concurrent edit fails safely",
    );
  },
);

Deno.test(
  "worker treats a PDS 404 as no annotation and creates a fresh record without swapRecord",
  async () => {
    await clearMirrorTables();
    await bookmark("a");
    await enqueueMissingPreviewJobsForDid(DID, 10);
    const job = (await claimPreviewEnrichmentJobs(1))[0];

    let written: any = null;
    let swapSeen: string | undefined = "unset";
    const before = Date.now();
    const stats = await processPreviewEnrichmentJob(job, {
      restoreSession: () =>
        Promise.resolve({ did: DID, pdsUrl: "https://pds.test" }),
      readAnnotation: () => Promise.resolve(null),
      extractUrlMetadata: () =>
        Promise.resolve({
          title: "Title",
          description: "Desc",
          favicon: "https://example.com/favicon.ico",
          image: "https://example.com/og.png",
        }),
      writeAnnotation: (_session, _rkey, annotationRecord, options) => {
        written = annotationRecord;
        swapSeen = options?.swapRecord;
        return Promise.resolve({ ok: true });
      },
    });
    assertEquals(stats.success, 1);
    assertEquals(written.note, undefined);
    assertEquals(swapSeen, undefined, "no existing record → no swapRecord");
    const createdAt = Date.parse(written.createdAt);
    assert(
      !Number.isNaN(createdAt) && createdAt >= before - 5_000 &&
        createdAt <= before + 5_000,
      "a fresh record is stamped with a current createdAt",
    );
  },
);

Deno.test(
  "worker never falls back to a stale mirror after a PDS read error and does not write",
  async () => {
    await clearMirrorTables();
    await bookmark("yt", YT_VIDEO_URL);
    // A stale mirror row exists with a note — it must NOT become the merge
    // base when the authoritative PDS read fails.
    await annotation("yt", {
      title: "Stale Mirror Title",
      note: "mirror only note",
    });
    assertEquals(await enqueueMissingPreviewJobsForDid(DID, 10), 1);
    const job = (await claimPreviewEnrichmentJobs(1))[0];

    let wrote = false;
    const stats = await processPreviewEnrichmentJob(job, {
      restoreSession: () =>
        Promise.resolve({ did: DID, pdsUrl: "https://pds.test" }),
      readAnnotation: () =>
        Promise.reject(new Error("getRecord failed: HTTP 500")),
      extractUrlMetadata: () =>
        Promise.resolve({
          title: "Fetched",
          favicon: "https://www.youtube.com/favicon.ico",
          image: "https://i.ytimg.com/vi/x/hqdefault.jpg",
        }),
      writeAnnotation: () => {
        wrote = true;
        return Promise.resolve({ ok: true });
      },
    });
    assertEquals(stats.success, 0);
    assertEquals(stats.retry, 1);
    assertEquals(
      wrote,
      false,
      "a PDS read failure must never merge or overwrite from a stale mirror",
    );
    // The stale mirror row is untouched and the job is bounded-retrying.
    const rows = await db.execute({
      sql: "SELECT title, note FROM annotations WHERE subject = ?",
      args: [job.bookmarkUri],
    });
    assertEquals(rows.rows[0], ["Stale Mirror Title", "mirror only note"]);
    const jobRows = await db.execute({
      sql:
        "SELECT status, attempts FROM preview_enrichment_jobs WHERE bookmark_uri = ?",
      args: [job.bookmarkUri],
    });
    assertEquals(jobRows.rows[0], ["pending", 1]);
  },
);

Deno.test(
  "worker retries without overwriting when the PDS write fails (e.g. InvalidSwap from a concurrent edit)",
  async () => {
    await clearMirrorTables();
    await bookmark("yt", YT_VIDEO_URL);
    await annotation("yt", { title: "- YouTube" });
    assertEquals(await enqueueMissingPreviewJobsForDid(DID, 10), 1);
    const job = (await claimPreviewEnrichmentJobs(1))[0];

    const stats = await processPreviewEnrichmentJob(job, {
      restoreSession: () =>
        Promise.resolve({ did: DID, pdsUrl: "https://pds.test" }),
      readAnnotation: () =>
        Promise.resolve({
          uri: `at://${DID}/com.kipclip.annotation/${job.rkey}`,
          cid: "bafyuser",
          value: { subject: job.bookmarkUri, title: "- YouTube" },
        }),
      extractUrlMetadata: () =>
        Promise.resolve({
          title: "Real Title",
          description: "Real description",
          favicon: "https://www.youtube.com/favicon.ico",
          image: "https://i.ytimg.com/vi/x/hqdefault.jpg",
        }),
      // The PDS rejects the put (400 InvalidSwap: someone else wrote between
      // our read and our write). The worker must fail safely and retry, never
      // overwrite or mark done.
      writeAnnotation: () => Promise.resolve({ ok: false }),
    });
    assertEquals(stats.success, 0);
    assertEquals(stats.retry, 1);
    const jobRows = await db.execute({
      sql:
        "SELECT status, attempts FROM preview_enrichment_jobs WHERE bookmark_uri = ?",
      args: [job.bookmarkUri],
    });
    assertEquals(jobRows.rows[0], ["pending", 1]);
  },
);

Deno.test(
  "worker bounded retry stops at the failure limit: three attempts then failed with no further claims",
  async () => {
    await clearMirrorTables();
    await bookmark("yt", YT_VIDEO_URL);
    await annotation("yt", { title: "- YouTube" });
    assertEquals(await enqueueMissingPreviewJobsForDid(DID, 10), 1);
    let job = (await claimPreviewEnrichmentJobs(1))[0];

    const deps = {
      restoreSession: () =>
        Promise.resolve({ did: DID, pdsUrl: "https://pds.test" }),
      readAnnotation: () =>
        Promise.resolve({
          uri: `at://${DID}/com.kipclip.annotation/${job.rkey}`,
          cid: "bafyuser",
          value: { subject: job.bookmarkUri, title: "- YouTube" },
        }),
      extractUrlMetadata: () =>
        Promise.resolve({
          title: "Real Title",
          favicon: "https://www.youtube.com/favicon.ico",
          image: "https://i.ytimg.com/vi/x/hqdefault.jpg",
        }),
      writeAnnotation: () => Promise.resolve({ ok: true }),
    };

    const attemptsSeen: number[] = [];
    for (let i = 0; i < 3; i++) {
      const stats = await processPreviewEnrichmentJob(job, deps);
      attemptsSeen.push(stats.retry === 1 ? 1 : 0);
      const rows = await db.execute({
        sql:
          "SELECT status, attempts FROM preview_enrichment_jobs WHERE bookmark_uri = ?",
        args: [job.bookmarkUri],
      });
      job = { ...job, attempts: Number(rows.rows[0][1]) };
      if (i < 2) assertEquals(rows.rows[0][0], "pending");
      else assertEquals(rows.rows[0][0], "failed");
    }
    assertEquals(attemptsSeen, [1, 1, 0], "retry ×2 then stopped at the limit");

    // The established failure limit is terminal: no more claims, and the next
    // tick's periodic enqueue does not reopen the failed job with fresh
    // attempts (the unbounded-loop bug: it must stay failed, never a new
    // attempts=0 pending job).
    assertEquals(await claimPreviewEnrichmentJobs(5, Date.now()), []);
    const finalRows = await db.execute({
      sql:
        "SELECT status, attempts FROM preview_enrichment_jobs WHERE bookmark_uri = ?",
      args: [job.bookmarkUri],
    });
    assertEquals(
      finalRows.rows[0],
      ["failed", 3],
      "periodic enqueue must not reopen a failed job",
    );
  },
);

// ============================================================================
// Record-level usability predicate (webhook echo protection)
// ============================================================================

Deno.test(
  "isUsableAnnotationRecord - record-level usability agrees with hasUsableAnnotation",
  () => {
    // YouTube: incomplete without a description — must protect the retry job.
    assertEquals(
      isUsableAnnotationRecord({
        subjectUrl: YT_VIDEO_URL,
        title: "Real Video Title",
        image: "https://i.ytimg.com/vi/x/hqdefault.jpg",
        favicon: "https://www.youtube.com/favicon.ico",
      }),
      false,
      "a YouTube record without a description is incomplete",
    );
    // YouTube: default title with a note is still incomplete.
    assertEquals(
      isUsableAnnotationRecord({
        subjectUrl: YT_VIDEO_URL,
        title: "- YouTube",
        description: "Real description",
        image: "https://i.ytimg.com/vi/x/hqdefault.jpg",
        favicon: "https://www.youtube.com/favicon.ico",
        note: "keep my note",
      }),
      false,
      "a default YouTube title must not be treated as complete",
    );
    // YouTube: all four preview fields present and non-default.
    assertEquals(
      isUsableAnnotationRecord({
        subjectUrl: YT_VIDEO_URL,
        title: "Real Video Title",
        description: "Real description",
        image: "https://i.ytimg.com/vi/x/hqdefault.jpg",
        favicon: "https://www.youtube.com/favicon.ico",
      }),
      true,
      "a complete YouTube record is usable",
    );
    // Non-YouTube: meaningful title alone is usable (settles preview work).
    assertEquals(
      isUsableAnnotationRecord({
        subjectUrl: "https://example.com/page",
        title: "Custom Title",
      }),
      true,
    );
    // Non-YouTube: note alone is usable.
    assertEquals(
      isUsableAnnotationRecord({
        subjectUrl: "https://example.com/page",
        note: "keep",
      }),
      true,
    );
    // Non-YouTube: empty record is not usable (keeps the retry job).
    assertEquals(
      isUsableAnnotationRecord({ subjectUrl: "https://example.com/page" }),
      false,
    );
    // Literal 'YouTube' title on a non-YouTube subject stays usable.
    assertEquals(
      isUsableAnnotationRecord({
        subjectUrl: "https://example.com/about-youtube",
        title: "YouTube",
      }),
      true,
    );
    // Unknown subject URL behaves like non-YouTube.
    assertEquals(
      isUsableAnnotationRecord({
        subjectUrl: null,
        title: "Real Video Title",
      }),
      true,
    );
  },
);
