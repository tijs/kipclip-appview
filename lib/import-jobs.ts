/**
 * Import job database operations.
 * Stores chunked import work in SQLite for client-driven batch processing.
 */

import { db } from "./db.ts";
import { generateTidForTimestamp } from "./tid.ts";
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
  /** ISO timestamp of supporter verification at prepare-time (null if not yet checked). */
  supporterVerifiedAt: string | null;
}

export interface ImportChunk {
  id: number;
  jobId: string;
  chunkIndex: number;
  bookmarks: (ImportedBookmark & { rkey: string })[];
  status: string;
  leaseToken: string;
  processedBookmarks: number;
  imported: number;
  failed: number;
  reclaimed: boolean;
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
  const used = new Set<string>();
  const planned = bookmarks.map((b) => {
    const createdAt = b.createdAt || new Date().toISOString();
    let rkey: string;
    let offset = 0;
    do {
      rkey = generateTidForTimestamp(
        new Date(Date.parse(createdAt) + offset++),
      );
    } while (used.has(rkey));
    used.add(rkey);
    return { ...b, createdAt, rkey };
  });
  const chunks = Array.from(
    { length: Math.ceil(planned.length / CHUNK_SIZE) },
    (_, i) => planned.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE),
  );
  const supporterVerifiedAt = new Date().toISOString();
  await db.transaction(async (tx) => {
    const active = await tx.execute({
      sql: `SELECT 1 FROM import_chunks c JOIN import_jobs j ON j.id = c.job_id
        WHERE j.did = ? AND c.status = 'running' AND c.lease_until > ? LIMIT 1`,
      args: [did, Date.now()],
    });
    if (active.rows.length) {
      throw new Error(
        "An import is already processing; wait for it to finish before preparing another",
      );
    }
    await tx.execute({
      sql: `DELETE FROM import_chunks WHERE job_id IN
      (SELECT id FROM import_jobs WHERE did = ? AND status IN ('pending', 'processing'))`,
      args: [did],
    });
    await tx.execute({
      sql:
        `DELETE FROM import_jobs WHERE did = ? AND status IN ('pending', 'processing')`,
      args: [did],
    });
    await tx.execute({
      sql: `INSERT INTO import_jobs
        (id, did, format, total, skipped, total_chunks, tags, supporter_verified_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        id,
        did,
        format,
        total,
        skipped,
        chunks.length,
        JSON.stringify(tags),
        supporterVerifiedAt,
      ],
    });
    for (let i = 0; i < chunks.length; i++) {
      await tx.execute({
        sql: `INSERT INTO import_chunks (job_id, chunk_index, bookmarks)
        VALUES (?, ?, ?)`,
        args: [id, i, JSON.stringify(chunks[i])],
      });
    }
  });

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
    supporterVerifiedAt,
  };
}

/** Get an import job by ID. */
export async function getImportJob(
  jobId: string,
): Promise<ImportJob | null> {
  const result = await db.execute({
    sql: `SELECT id, did, format, total, skipped, imported, failed,
                 total_chunks, processed_chunks, tags, status,
                 supporter_verified_at
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
    supporterVerifiedAt: row[11] == null ? null : String(row[11]),
  };
}

const LEASE_MS = 60_000;

/** Claim at most one chunk per job; a second tab cannot race the external writes. */
export async function getNextPendingChunk(
  jobId: string,
  now = Date.now(),
): Promise<ImportChunk | null> {
  return await db.transaction(async (tx) => {
    const token = crypto.randomUUID();
    const rows = await tx.execute({
      sql:
        `SELECT c.id, c.chunk_index, c.bookmarks, c.status, c.processed_bookmarks, c.imported, c.failed
        FROM import_chunks c JOIN import_jobs j ON j.id = c.job_id
        WHERE c.job_id = ? AND j.status IN ('pending', 'processing')
        AND (c.status = 'pending' OR (c.status = 'running' AND c.lease_until <= ?))
        AND NOT EXISTS (SELECT 1 FROM import_chunks active WHERE active.job_id = c.job_id
          AND active.status = 'running' AND active.lease_until > ?)
        ORDER BY c.chunk_index LIMIT 1`,
      args: [jobId, now, now],
    });
    if (!rows.rows.length) return null;
    const row = rows.rows[0];
    // Older prepared jobs receive stable identities once, before any new side effect.
    const bookmarks = JSON.parse(String(row[2])).map((
      b: ImportedBookmark & { rkey?: string },
    ) => ({
      ...b,
      createdAt: b.createdAt || new Date(now).toISOString(),
      rkey: b.rkey || generateTidForTimestamp(new Date(b.createdAt || now)),
    }));
    await tx.execute({
      sql: `UPDATE import_chunks SET status = 'running', lease_token = ?,
      lease_until = ?, bookmarks = ? WHERE id = ?`,
      args: [token, now + LEASE_MS, JSON.stringify(bookmarks), row[0]],
    });
    return {
      id: Number(row[0]),
      jobId,
      chunkIndex: Number(row[1]),
      bookmarks,
      status: "running",
      leaseToken: token,
      processedBookmarks: Number(row[4]),
      imported: Number(row[5]),
      failed: Number(row[6]),
      reclaimed: row[3] === "running",
    };
  });
}

/** Renew and prove ownership before each bounded external batch. */
export async function renewImportChunk(
  chunk: ImportChunk,
  now = Date.now(),
): Promise<boolean> {
  const result = await db.execute({
    sql: `UPDATE import_chunks SET lease_until = ?
    WHERE id = ? AND job_id = ? AND status = 'running' AND lease_token = ? AND lease_until > ?
    AND EXISTS (SELECT 1 FROM import_jobs WHERE id = ? AND status IN ('pending', 'processing'))`,
    args: [
      now + LEASE_MS,
      chunk.id,
      chunk.jobId,
      chunk.leaseToken,
      now,
      chunk.jobId,
    ],
  });
  return result.rowsAffected === 1;
}

/** An uncertain external result must recover at the same IDs, not count as failure. */
export async function deferImportChunk(chunk: ImportChunk): Promise<void> {
  await db.execute({
    sql: `UPDATE import_chunks SET lease_until = 0
    WHERE id = ? AND job_id = ? AND status = 'running' AND lease_token = ?`,
    args: [chunk.id, chunk.jobId, chunk.leaseToken],
  });
}

/** Checkpoint only the current owner; a late result must not settle replacement work. */
export async function checkpointImportChunk(
  chunk: ImportChunk,
  processed: number,
  imported: number,
  failed: number,
  done = false,
): Promise<boolean> {
  return await db.transaction(async (tx) => {
    const result = await tx.execute({
      sql:
        `UPDATE import_chunks SET processed_bookmarks = ?, imported = ?, failed = ?,
      status = ?, lease_until = ? WHERE id = ? AND job_id = ? AND status = 'running' AND lease_token = ?
      AND EXISTS (SELECT 1 FROM import_jobs WHERE id = ? AND status IN ('pending', 'processing'))`,
      args: [
        processed,
        imported,
        failed,
        done ? "done" : "running",
        done ? 0 : Date.now() + LEASE_MS,
        chunk.id,
        chunk.jobId,
        chunk.leaseToken,
        chunk.jobId,
      ],
    });
    if (result.rowsAffected !== 1) return false;
    await tx.execute({
      sql: `UPDATE import_jobs SET
      imported = imported_baseline + (SELECT COALESCE(SUM(imported), 0) FROM import_chunks WHERE job_id = ?),
      failed = failed_baseline + (SELECT COALESCE(SUM(failed), 0) FROM import_chunks WHERE job_id = ?),
      processed_chunks = (SELECT COUNT(*) FROM import_chunks WHERE job_id = ? AND status = 'done'),
      status = 'processing', updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      args: [chunk.jobId, chunk.jobId, chunk.jobId, chunk.jobId],
    });
    return true;
  });
}

export async function completeChunk(
  chunk: ImportChunk,
  imported: number,
  failed: number,
): Promise<boolean> {
  return await checkpointImportChunk(
    chunk,
    chunk.bookmarks.length,
    imported,
    failed,
    true,
  );
}

/** Completion depends on actual chunk states, never counters supplied by a caller. */
export async function markJobCompleted(jobId: string): Promise<boolean> {
  const result = await db.execute({
    sql:
      `UPDATE import_jobs SET status = 'completed', updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND status IN ('pending', 'processing')
    AND NOT EXISTS (SELECT 1 FROM import_chunks WHERE job_id = ? AND status != 'done')`,
    args: [jobId, jobId],
  });
  return result.rowsAffected === 1;
}

/** Compare timestamps as dates and keep actively leased imports intact. */
export async function cleanupOldJobs(
  maxAgeHours = 24,
  now = Date.now(),
): Promise<void> {
  const cutoff = new Date(now - maxAgeHours * 60 * 60 * 1000).toISOString();
  await db.transaction(async (tx) => {
    const ids = await tx.execute({
      sql:
        `SELECT id FROM import_jobs j WHERE datetime(created_at) < datetime(?)
      AND NOT EXISTS (SELECT 1 FROM import_chunks c WHERE c.job_id = j.id AND c.status = 'running' AND c.lease_until > ?)`,
      args: [cutoff, now],
    });
    for (const [id] of ids.rows) {
      await tx.execute({
        sql: "DELETE FROM import_chunks WHERE job_id = ?",
        args: [id],
      });
      await tx.execute({
        sql: "DELETE FROM import_jobs WHERE id = ?",
        args: [id],
      });
    }
  });
}
