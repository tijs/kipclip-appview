/**
 * Import job database operations.
 * Stores chunked import work in Turso/libSQL for client-driven batch processing.
 */

import { rawDb } from "./db.ts";
import type { ImportedBookmark } from "../shared/types.ts";

const CHUNK_SIZE = 200;

export interface ImportJob {
  id: string;
  did: string;
  format: string;
  total: number;
  skipped: number;
  imported: number;
  failed: number;
  totalChunks: number;
  processedChunks: number;
  tags: string[];
  status: string;
}

export interface ImportChunk {
  id: number;
  jobId: string;
  chunkIndex: number;
  bookmarks: ImportedBookmark[];
  status: string;
}

/**
 * Create an import job with chunked bookmarks.
 * Splits bookmarks into chunks of CHUNK_SIZE and stores them in the database.
 */
export async function createImportJob(
  did: string,
  format: string,
  total: number,
  skipped: number,
  bookmarks: ImportedBookmark[],
  tags: string[],
): Promise<ImportJob> {
  const id = crypto.randomUUID();
  const chunks: ImportedBookmark[][] = [];

  for (let i = 0; i < bookmarks.length; i += CHUNK_SIZE) {
    chunks.push(bookmarks.slice(i, i + CHUNK_SIZE));
  }

  await rawDb.execute({
    sql: `INSERT INTO import_jobs
          (id, did, format, total, skipped, total_chunks, tags)
          VALUES (?, ?, ?, ?, ?, ?, ?)`,
    args: [
      id,
      did,
      format,
      total,
      skipped,
      chunks.length,
      JSON.stringify(tags),
    ],
  });

  for (let i = 0; i < chunks.length; i++) {
    await rawDb.execute({
      sql: `INSERT INTO import_chunks (job_id, chunk_index, bookmarks)
            VALUES (?, ?, ?)`,
      args: [id, i, JSON.stringify(chunks[i])],
    });
  }

  return {
    id,
    did,
    format,
    total,
    skipped,
    imported: 0,
    failed: 0,
    totalChunks: chunks.length,
    processedChunks: 0,
    tags,
    status: "pending",
  };
}

/** Get an import job by ID. */
export async function getImportJob(
  jobId: string,
): Promise<ImportJob | null> {
  const result = await rawDb.execute({
    sql: `SELECT id, did, format, total, skipped, imported, failed,
                 total_chunks, processed_chunks, tags, status
          FROM import_jobs WHERE id = ?`,
    args: [jobId],
  });

  if (!result.rows || result.rows.length === 0) return null;

  const row = result.rows[0] as (string | number | null)[];
  return {
    id: String(row[0]),
    did: String(row[1]),
    format: String(row[2]),
    total: Number(row[3]),
    skipped: Number(row[4]),
    imported: Number(row[5]),
    failed: Number(row[6]),
    totalChunks: Number(row[7]),
    processedChunks: Number(row[8]),
    tags: JSON.parse(String(row[9] ?? "[]")),
    status: String(row[10]),
  };
}

/** Get the next pending chunk for a job. */
export async function getNextPendingChunk(
  jobId: string,
): Promise<ImportChunk | null> {
  const result = await rawDb.execute({
    sql: `SELECT id, job_id, chunk_index, bookmarks, status
          FROM import_chunks
          WHERE job_id = ? AND status = 'pending'
          ORDER BY chunk_index ASC
          LIMIT 1`,
    args: [jobId],
  });

  if (!result.rows || result.rows.length === 0) return null;

  const row = result.rows[0] as (string | number | null)[];
  return {
    id: Number(row[0]),
    jobId: String(row[1]),
    chunkIndex: Number(row[2]),
    bookmarks: JSON.parse(String(row[3])),
    status: String(row[4]),
  };
}

/** Mark a chunk as done and update job counters. */
export async function completeChunk(
  chunkId: number,
  jobId: string,
  imported: number,
  failed: number,
): Promise<void> {
  await rawDb.execute({
    sql: `UPDATE import_chunks SET status = 'done' WHERE id = ?`,
    args: [chunkId],
  });

  await rawDb.execute({
    sql: `UPDATE import_jobs
          SET imported = imported + ?,
              failed = failed + ?,
              processed_chunks = processed_chunks + 1,
              status = 'processing',
              updated_at = CURRENT_TIMESTAMP
          WHERE id = ?`,
    args: [imported, failed, jobId],
  });
}

/** Mark a job as completed. */
export async function markJobCompleted(jobId: string): Promise<void> {
  await rawDb.execute({
    sql: `UPDATE import_jobs
          SET status = 'completed', updated_at = CURRENT_TIMESTAMP
          WHERE id = ?`,
    args: [jobId],
  });
}

/** Delete old import jobs and their chunks. */
export async function cleanupOldJobs(maxAgeHours = 24): Promise<void> {
  const cutoff = new Date(Date.now() - maxAgeHours * 60 * 60 * 1000)
    .toISOString();

  await rawDb.execute({
    sql: `DELETE FROM import_chunks
          WHERE job_id IN (
            SELECT id FROM import_jobs WHERE created_at < ?
          )`,
    args: [cutoff],
  });

  await rawDb.execute({
    sql: `DELETE FROM import_jobs WHERE created_at < ?`,
    args: [cutoff],
  });
}

/** Delete existing pending/processing jobs for a DID. */
export async function deleteJobsForDid(did: string): Promise<void> {
  await rawDb.execute({
    sql: `DELETE FROM import_chunks
          WHERE job_id IN (
            SELECT id FROM import_jobs
            WHERE did = ? AND status IN ('pending', 'processing')
          )`,
    args: [did],
  });

  await rawDb.execute({
    sql: `DELETE FROM import_jobs
          WHERE did = ? AND status IN ('pending', 'processing')`,
    args: [did],
  });
}
