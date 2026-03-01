/**
 * Import API routes.
 * POST /api/import — prepare: parse file, dedup, store chunked work in Turso.
 * POST /api/import/:jobId/process — process one chunk via applyWrites.
 * GET /api/import/:jobId — get current job status.
 */

import type { App } from "@fresh/core";
import { parseBookmarkFile } from "../../lib/import-parsers.ts";
import {
  ANNOTATION_COLLECTION,
  BOOKMARK_COLLECTION,
  createAuthErrorResponse,
  createNewTagRecords,
  getSessionFromRequest,
  listAllRecords,
  setSessionCookie,
  TAG_COLLECTION,
} from "../../lib/route-utils.ts";
import { getBaseUrl } from "../../shared/url-utils.ts";
import {
  deduplicateTagsCaseInsensitive,
  resolveTagCasing,
} from "../../shared/tag-utils.ts";
import type {
  ImportPrepareResponse,
  ImportProcessResponse,
} from "../../shared/types.ts";
import {
  cleanupOldJobs,
  completeChunk,
  createImportJob,
  deleteJobsForDid,
  getImportJob,
  getNextPendingChunk,
  markJobCompleted,
} from "../../lib/import-jobs.ts";

export function registerImportRoutes(app: App<any>): App<any> {
  // Prepare: parse, dedup, store chunks
  app = app.post("/api/import", async (ctx) => {
    try {
      const { session: oauthSession, setCookieHeader, error } =
        await getSessionFromRequest(ctx.req);
      if (!oauthSession) {
        return createAuthErrorResponse(error);
      }

      // Parse multipart form data
      let fileContent: string;
      try {
        const formData = await ctx.req.formData();
        const file = formData.get("file");
        if (!file || !(file instanceof File)) {
          return Response.json(
            {
              success: false,
              error: "No file provided",
            } as ImportPrepareResponse,
            { status: 400 },
          );
        }
        fileContent = await file.text();
      } catch {
        return Response.json(
          {
            success: false,
            error: "Invalid form data",
          } as ImportPrepareResponse,
          { status: 400 },
        );
      }

      if (!fileContent.trim()) {
        return Response.json(
          { success: false, error: "File is empty" } as ImportPrepareResponse,
          { status: 400 },
        );
      }

      // Parse the file
      let format: string;
      let bookmarks;
      try {
        const result = parseBookmarkFile(fileContent);
        format = result.format;
        bookmarks = result.bookmarks;
      } catch (err: any) {
        return Response.json(
          { success: false, error: err.message } as ImportPrepareResponse,
          { status: 400 },
        );
      }

      const total = bookmarks.length;
      if (total === 0) {
        const resp: ImportPrepareResponse = {
          success: true,
          result: { imported: 0, skipped: 0, failed: 0, total: 0, format },
        };
        return setSessionCookie(Response.json(resp), setCookieHeader);
      }

      // Fetch existing bookmarks for dedup
      const existingUrls = new Set<string>();
      let cursor: string | undefined;
      do {
        const params = new URLSearchParams({
          repo: oauthSession.did,
          collection: BOOKMARK_COLLECTION,
          limit: "100",
        });
        if (cursor) params.set("cursor", cursor);

        const res = await oauthSession.makeRequest(
          "GET",
          `${oauthSession.pdsUrl}/xrpc/com.atproto.repo.listRecords?${params}`,
        );
        if (!res.ok) break;

        const data = await res.json();
        for (const rec of data.records || []) {
          const base = getBaseUrl(rec.value.subject);
          if (base) existingUrls.add(base);
        }
        cursor = data.cursor;
      } while (cursor);

      // Filter out duplicates
      const newBookmarks = bookmarks.filter((b) => {
        const base = getBaseUrl(b.url);
        return base && !existingUrls.has(base);
      });

      const skipped = total - newBookmarks.length;

      // If nothing to import after dedup, return immediately
      if (newBookmarks.length === 0) {
        const resp: ImportPrepareResponse = {
          success: true,
          result: { imported: 0, skipped, failed: 0, total, format },
        };
        return setSessionCookie(Response.json(resp), setCookieHeader);
      }

      // Collect all unique tags (case-insensitive) and resolve against existing PDS tags
      const rawTags: string[] = [];
      for (const b of newBookmarks) {
        for (const t of b.tags) rawTags.push(t);
      }
      const existingTagRecords = await listAllRecords(
        oauthSession,
        TAG_COLLECTION,
      );
      const existingTagValues = existingTagRecords
        .map((r: any) => r.value?.value)
        .filter(Boolean);
      const allTags = deduplicateTagsCaseInsensitive(
        resolveTagCasing(rawTags, existingTagValues),
      );

      // Resolve each bookmark's tags to use canonical casing
      for (const b of newBookmarks) {
        b.tags = resolveTagCasing(b.tags, existingTagValues);
      }

      // Probabilistically clean up old jobs (~10% of requests)
      if (Math.random() < 0.1) {
        await cleanupOldJobs().catch((err) =>
          console.error("Failed to cleanup old import jobs:", err)
        );
      }
      // Always clean up existing pending jobs for this user
      await deleteJobsForDid(oauthSession.did).catch((err) =>
        console.error("Failed to delete existing import jobs:", err)
      );

      // Create the import job with chunked bookmarks
      const job = await createImportJob(
        oauthSession.did,
        format,
        total,
        skipped,
        newBookmarks,
        allTags,
      );

      const resp: ImportPrepareResponse = {
        success: true,
        jobId: job.id,
        total,
        skipped,
        toImport: newBookmarks.length,
        totalChunks: job.totalChunks,
        format,
      };
      return setSessionCookie(Response.json(resp), setCookieHeader);
    } catch (error: any) {
      console.error("Import prepare error:", error);
      return Response.json(
        { success: false, error: error.message } as ImportPrepareResponse,
        { status: 500 },
      );
    }
  });

  // Process one chunk
  app = app.post("/api/import/:jobId/process", async (ctx) => {
    try {
      const { session: oauthSession, setCookieHeader, error } =
        await getSessionFromRequest(ctx.req);
      if (!oauthSession) {
        return createAuthErrorResponse(error);
      }

      const { jobId } = ctx.params;
      const job = await getImportJob(jobId);

      if (!job) {
        return Response.json(
          {
            success: false,
            error: "Import job not found",
          } as ImportProcessResponse,
          { status: 404 },
        );
      }

      // Security: verify the job belongs to this user
      if (job.did !== oauthSession.did) {
        return Response.json(
          { success: false, error: "Forbidden" } as ImportProcessResponse,
          { status: 403 },
        );
      }

      // If job already completed, return final result
      if (job.status === "completed") {
        const resp: ImportProcessResponse = {
          success: true,
          done: true,
          totalImported: job.imported,
          totalFailed: job.failed,
          remaining: 0,
          result: {
            imported: job.imported,
            skipped: job.skipped,
            failed: job.failed,
            total: job.total,
            format: job.format,
          },
        };
        return setSessionCookie(Response.json(resp), setCookieHeader);
      }

      // Get next pending chunk
      const chunk = await getNextPendingChunk(jobId);

      if (!chunk) {
        // No pending chunks left — mark job completed and create tags
        await markJobCompleted(jobId);
        const finalJob = await getImportJob(jobId);

        if (finalJob && finalJob.tags.length > 0) {
          await createNewTagRecords(oauthSession, finalJob.tags).catch((err) =>
            console.error("Failed to create tag records during import:", err)
          );
        }

        const resp: ImportProcessResponse = {
          success: true,
          done: true,
          totalImported: finalJob?.imported ?? job.imported,
          totalFailed: finalJob?.failed ?? job.failed,
          remaining: 0,
          result: {
            imported: finalJob?.imported ?? job.imported,
            skipped: finalJob?.skipped ?? job.skipped,
            failed: finalJob?.failed ?? job.failed,
            total: finalJob?.total ?? job.total,
            format: finalJob?.format ?? job.format,
          },
        };
        return setSessionCookie(Response.json(resp), setCookieHeader);
      }

      // Build write operations grouped per bookmark, then batch into
      // sub-batches of max 10 operations (AT Protocol applyWrites limit).
      const did = oauthSession.did;
      const MAX_WRITES = 10;

      // Group writes per bookmark so we can track imported/failed per bookmark
      const bookmarkWrites: {
        bookmark: typeof chunk.bookmarks[0];
        ops: any[];
      }[] = chunk.bookmarks.map((b) => {
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

        return { bookmark: b, ops };
      });

      // Pack bookmarks into sub-batches that fit within MAX_WRITES
      const subBatches: typeof bookmarkWrites[] = [];
      let currentBatch: typeof bookmarkWrites = [];
      let currentOps = 0;

      for (const bw of bookmarkWrites) {
        if (
          currentOps + bw.ops.length > MAX_WRITES && currentBatch.length > 0
        ) {
          subBatches.push(currentBatch);
          currentBatch = [];
          currentOps = 0;
        }
        currentBatch.push(bw);
        currentOps += bw.ops.length;
      }
      if (currentBatch.length > 0) subBatches.push(currentBatch);

      let chunkImported = 0;
      let chunkFailed = 0;

      for (const batch of subBatches) {
        const writes = batch.flatMap((bw) => bw.ops);
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
            chunkImported += batch.length;
          } else {
            const errorText = await res.text();
            console.error(`Import applyWrites failed: ${errorText}`);
            chunkFailed += batch.length;
          }
        } catch (err) {
          console.error("Import applyWrites error:", err);
          chunkFailed += batch.length;
        }
      }

      // Update chunk and job counters
      await completeChunk(chunk.id, jobId, chunkImported, chunkFailed);

      // Reload job for updated counters
      const updatedJob = await getImportJob(jobId);
      const allDone = updatedJob &&
        updatedJob.processedChunks >= updatedJob.totalChunks;

      if (allDone && updatedJob) {
        await markJobCompleted(jobId);

        if (updatedJob.tags.length > 0) {
          await createNewTagRecords(oauthSession, updatedJob.tags).catch(
            (err) =>
              console.error(
                "Failed to create tag records during import:",
                err,
              ),
          );
        }
      }

      const remaining = updatedJob
        ? updatedJob.totalChunks - updatedJob.processedChunks
        : 0;

      const resp: ImportProcessResponse = {
        success: true,
        imported: chunkImported,
        failed: chunkFailed,
        totalImported: updatedJob?.imported ?? chunkImported,
        totalFailed: updatedJob?.failed ?? chunkFailed,
        remaining,
        done: !!allDone,
        result: allDone && updatedJob
          ? {
            imported: updatedJob.imported,
            skipped: updatedJob.skipped,
            failed: updatedJob.failed,
            total: updatedJob.total,
            format: updatedJob.format,
          }
          : undefined,
      };
      return setSessionCookie(Response.json(resp), setCookieHeader);
    } catch (error: any) {
      console.error("Import process error:", error);
      return Response.json(
        { success: false, error: error.message } as ImportProcessResponse,
        { status: 500 },
      );
    }
  });

  // Status endpoint
  app = app.get("/api/import/:jobId", async (ctx) => {
    try {
      const { session: oauthSession, setCookieHeader, error } =
        await getSessionFromRequest(ctx.req);
      if (!oauthSession) {
        return createAuthErrorResponse(error);
      }

      const { jobId } = ctx.params;
      const job = await getImportJob(jobId);

      if (!job) {
        return Response.json({ error: "Import job not found" }, {
          status: 404,
        });
      }

      if (job.did !== oauthSession.did) {
        return Response.json({ error: "Forbidden" }, { status: 403 });
      }

      const resp = {
        jobId: job.id,
        status: job.status,
        total: job.total,
        skipped: job.skipped,
        imported: job.imported,
        failed: job.failed,
        totalChunks: job.totalChunks,
        processedChunks: job.processedChunks,
        format: job.format,
      };
      return setSessionCookie(Response.json(resp), setCookieHeader);
    } catch (error: any) {
      console.error("Import status error:", error);
      return Response.json({ error: error.message }, { status: 500 });
    }
  });

  return app;
}
