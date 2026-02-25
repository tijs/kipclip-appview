/**
 * Background import processing via Deno KV queue.
 * Stores import job state and bookmark chunks in KV,
 * processes batches via kv.listenQueue for reliable background writes.
 */

import { getKv } from "./kv.ts";
import { getOAuth } from "./oauth-config.ts";
import {
  ANNOTATION_COLLECTION,
  BOOKMARK_COLLECTION,
  createNewTagRecords,
} from "./route-utils.ts";
import type {
  ImportBatchMessage,
  ImportedBookmark,
  ImportJob,
} from "../shared/types.ts";

const TTL = 3600000; // 1 hour
const BATCH_SIZE = 200;

/** Store a new import job with bookmark chunks in KV. */
export async function createImportJob(
  jobId: string,
  job: ImportJob,
  chunks: ImportedBookmark[][],
  tags: string[],
): Promise<void> {
  const kv = await getKv();
  const expireIn = TTL;

  // Atomic set for job + all chunks + tags
  let op = kv.atomic()
    .set(["import", jobId, "job"], job, { expireIn });

  for (let i = 0; i < chunks.length; i++) {
    op = op.set(["import", jobId, "chunk", i], chunks[i], { expireIn });
  }

  op = op.set(["import", jobId, "tags"], tags, { expireIn });

  await op.commit();
}

/** Read job state from KV. */
export async function getImportJob(
  jobId: string,
): Promise<ImportJob | null> {
  const kv = await getKv();
  const result = await kv.get<ImportJob>(["import", jobId, "job"]);
  return result.value;
}

/** Atomically update job counters. */
export async function updateImportJob(
  jobId: string,
  updates: Partial<ImportJob>,
): Promise<void> {
  const kv = await getKv();

  // Read-modify-write with version check for atomicity
  const entry = await kv.get<ImportJob>(["import", jobId, "job"]);
  if (!entry.value) return;

  const updated = { ...entry.value, ...updates };
  await kv.atomic()
    .check(entry)
    .set(["import", jobId, "job"], updated, { expireIn: TTL })
    .commit();
}

/** Read a bookmark chunk from KV. */
export async function getChunk(
  jobId: string,
  index: number,
): Promise<ImportedBookmark[] | null> {
  const kv = await getKv();
  const result = await kv.get<ImportedBookmark[]>([
    "import",
    jobId,
    "chunk",
    index,
  ]);
  return result.value;
}

/** Type guard for queue messages. */
export function isImportBatchMessage(
  msg: unknown,
): msg is ImportBatchMessage {
  return (
    typeof msg === "object" &&
    msg !== null &&
    (msg as any).type === "import-batch" &&
    typeof (msg as any).jobId === "string" &&
    typeof (msg as any).did === "string" &&
    typeof (msg as any).chunkIndex === "number"
  );
}

/** Enqueue the first batch message for a job. */
export async function enqueueFirstBatch(
  jobId: string,
  did: string,
): Promise<void> {
  const kv = await getKv();
  const msg: ImportBatchMessage = {
    type: "import-batch",
    jobId,
    did,
    chunkIndex: 0,
  };
  await kv.enqueue(msg);
}

/**
 * Process a single import batch. Called by kv.listenQueue handler.
 * Reads a chunk, writes bookmarks to PDS, updates progress,
 * and enqueues the next batch if more chunks remain.
 */
export async function processImportBatch(
  msg: ImportBatchMessage,
): Promise<void> {
  const { jobId, did, chunkIndex } = msg;

  const job = await getImportJob(jobId);
  if (!job || job.status !== "processing") return;

  const chunk = await getChunk(jobId, chunkIndex);
  if (!chunk) {
    await updateImportJob(jobId, { status: "failed", error: "Missing chunk" });
    return;
  }

  // Restore OAuth session
  let oauthSession;
  try {
    oauthSession = await getOAuth().sessions.getOAuthSession(did);
    if (!oauthSession) {
      await updateImportJob(jobId, {
        status: "failed",
        error: "Session expired, please re-authenticate and try again",
      });
      return;
    }
  } catch {
    await updateImportJob(jobId, {
      status: "failed",
      error: "Failed to restore session",
    });
    return;
  }

  // Build applyWrites operations
  let batchImported = 0;
  let batchFailed = 0;

  for (let i = 0; i < chunk.length; i += BATCH_SIZE) {
    const batch = chunk.slice(i, i + BATCH_SIZE);
    const writes = batch.flatMap((b) => {
      const rkey = crypto.randomUUID().replace(/-/g, "").slice(0, 13);
      const createdAt = b.createdAt || new Date().toISOString();
      const bookmarkUri = `at://${did}/${BOOKMARK_COLLECTION}/${rkey}`;

      const ops: any[] = [
        {
          $type: "com.atproto.repo.applyWrites#create",
          collection: BOOKMARK_COLLECTION,
          rkey,
          value: { subject: b.url, createdAt, tags: b.tags },
        },
      ];

      if (b.title || b.description) {
        ops.push({
          $type: "com.atproto.repo.applyWrites#create",
          collection: ANNOTATION_COLLECTION,
          rkey,
          value: {
            subject: bookmarkUri,
            title: b.title,
            description: b.description,
            createdAt,
          },
        });
      }

      return ops;
    });

    try {
      const res = await oauthSession.makeRequest(
        "POST",
        `${oauthSession.pdsUrl}/xrpc/com.atproto.repo.applyWrites`,
        {
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ repo: did, writes }),
        },
      );

      if (res.ok) {
        batchImported += batch.length;
      } else {
        const errorText = await res.text();
        console.error(`Import batch ${chunkIndex} failed: ${errorText}`);
        batchFailed += batch.length;
      }
    } catch (err) {
      console.error(`Import batch ${chunkIndex} error:`, err);
      batchFailed += batch.length;
    }
  }

  // Update progress
  const newProcessedChunks = job.processedChunks + 1;
  const isLastChunk = newProcessedChunks >= job.totalChunks;

  if (isLastChunk) {
    // Create tag records on final chunk
    const kv = await getKv();
    const tagsEntry = await kv.get<string[]>(["import", jobId, "tags"]);
    if (tagsEntry.value && tagsEntry.value.length > 0) {
      await createNewTagRecords(oauthSession, tagsEntry.value).catch((err) =>
        console.error("Failed to create tag records during import:", err)
      );
    }

    await updateImportJob(jobId, {
      imported: job.imported + batchImported,
      failed: job.failed + batchFailed,
      processedChunks: newProcessedChunks,
      status: "complete",
    });
  } else {
    await updateImportJob(jobId, {
      imported: job.imported + batchImported,
      failed: job.failed + batchFailed,
      processedChunks: newProcessedChunks,
    });

    // Enqueue next batch
    const kv = await getKv();
    const nextMsg: ImportBatchMessage = {
      type: "import-batch",
      jobId,
      did,
      chunkIndex: chunkIndex + 1,
    };
    await kv.enqueue(nextMsg);
  }
}
