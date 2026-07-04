import { db } from "./db.ts";

export type PreviewJobStatus =
  | "pending"
  | "done"
  | "failed"
  | "blocked_no_session";

export interface PreviewEnrichmentJob {
  bookmarkUri: string;
  did: string;
  rkey: string;
  subject: string;
  status: PreviewJobStatus;
  attempts: number;
  nextRunAt: number;
  lastError: string | null;
}

export interface MissingPreviewBookmark {
  uri: string;
  did: string;
  rkey: string;
  subject: string;
}

const DAY = 24 * 60 * 60 * 1000;

function rowToJob(row: unknown[]): PreviewEnrichmentJob {
  return {
    bookmarkUri: String(row[0]),
    did: String(row[1]),
    rkey: String(row[2]),
    subject: String(row[3]),
    status: row[4] as PreviewJobStatus,
    attempts: Number(row[5]),
    nextRunAt: Number(row[6]),
    lastError: row[7] === null ? null : String(row[7]),
  };
}

export async function findMissingPreviewBookmarks(
  did: string,
  limit = 25,
): Promise<MissingPreviewBookmark[]> {
  const result = await db.execute({
    sql: `
      SELECT b.uri, b.did, b.rkey, b.subject
      FROM bookmarks b
      LEFT JOIN annotations a ON a.subject = b.uri AND a.did = b.did
      WHERE b.did = ?
        AND (
          a.uri IS NULL OR (
            COALESCE(a.title, '') = ''
            AND COALESCE(a.image, '') = ''
            AND COALESCE(a.favicon, '') = ''
          )
        )
      ORDER BY b.created_at DESC
      LIMIT ?
    `,
    args: [did, limit],
  });
  return result.rows.map((row) => ({
    uri: String(row[0]),
    did: String(row[1]),
    rkey: String(row[2]),
    subject: String(row[3]),
  }));
}

export async function enqueueMissingPreviewJobsForDid(
  did: string,
  limit = 25,
): Promise<number> {
  const missing = await findMissingPreviewBookmarks(did, limit);
  let enqueued = 0;
  const now = Date.now();
  for (const bookmark of missing) {
    const result = await db.execute({
      sql: `
        INSERT INTO preview_enrichment_jobs (
          bookmark_uri, did, rkey, subject, status, attempts,
          next_run_at, last_error, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'pending', 0, ?, NULL, ?, ?)
        ON CONFLICT(bookmark_uri) DO UPDATE SET
          subject = excluded.subject,
          rkey = excluded.rkey,
          status = CASE
            WHEN preview_enrichment_jobs.status IN ('done', 'failed', 'blocked_no_session')
              THEN 'pending'
            ELSE preview_enrichment_jobs.status
          END,
          attempts = CASE
            WHEN preview_enrichment_jobs.subject != excluded.subject THEN 0
            ELSE preview_enrichment_jobs.attempts
          END,
          next_run_at = CASE
            WHEN preview_enrichment_jobs.subject != excluded.subject THEN excluded.next_run_at
            ELSE preview_enrichment_jobs.next_run_at
          END,
          updated_at = excluded.updated_at
      `,
      args: [
        bookmark.uri,
        bookmark.did,
        bookmark.rkey,
        bookmark.subject,
        now,
        now,
        now,
      ],
    });
    if (result.rowsAffected > 0) enqueued++;
  }
  return enqueued;
}

export async function claimPreviewEnrichmentJobs(
  limit = 5,
  now = Date.now(),
): Promise<PreviewEnrichmentJob[]> {
  const result = await db.execute({
    sql: `
      SELECT bookmark_uri, did, rkey, subject, status, attempts,
             next_run_at, last_error
      FROM preview_enrichment_jobs
      WHERE status = 'pending' AND next_run_at <= ?
      ORDER BY next_run_at ASC, created_at ASC
      LIMIT ?
    `,
    args: [now, limit],
  });
  return result.rows.map(rowToJob);
}

export async function markPreviewJobDone(bookmarkUri: string): Promise<void> {
  await db.execute({
    sql: `
      UPDATE preview_enrichment_jobs
      SET status = 'done', last_error = NULL, updated_at = ?
      WHERE bookmark_uri = ?
    `,
    args: [Date.now(), bookmarkUri],
  });
}

export async function markPreviewJobBlockedNoSession(
  job: PreviewEnrichmentJob,
  now = Date.now(),
): Promise<void> {
  await db.execute({
    sql: `
      UPDATE preview_enrichment_jobs
      SET status = 'blocked_no_session', last_error = ?, updated_at = ?
      WHERE bookmark_uri = ?
    `,
    args: ["no usable OAuth session", now, job.bookmarkUri],
  });
}

export async function markPreviewJobRetry(
  job: PreviewEnrichmentJob,
  error: unknown,
  now = Date.now(),
): Promise<"pending" | "failed"> {
  const attempts = job.attempts + 1;
  const stopped = attempts >= 3;
  const nextRunAt = attempts === 1 ? now + DAY : now + 7 * DAY;
  const message = error instanceof Error ? error.message : String(error);
  await db.execute({
    sql: `
      UPDATE preview_enrichment_jobs
      SET status = ?, attempts = ?, next_run_at = ?, last_error = ?, updated_at = ?
      WHERE bookmark_uri = ?
    `,
    args: [
      stopped ? "failed" : "pending",
      attempts,
      stopped ? now : nextRunAt,
      message.slice(0, 500),
      now,
      job.bookmarkUri,
    ],
  });
  return stopped ? "failed" : "pending";
}

export async function hasUsableAnnotation(
  bookmarkUri: string,
): Promise<boolean> {
  const result = await db.execute({
    sql: `
      SELECT 1
      FROM annotations
      WHERE subject = ?
        AND (
          COALESCE(note, '') != ''
          OR COALESCE(title, '') != ''
          OR COALESCE(image, '') != ''
          OR COALESCE(favicon, '') != ''
        )
      LIMIT 1
    `,
    args: [bookmarkUri],
  });
  return result.rows.length > 0;
}
