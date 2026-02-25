/**
 * Import API routes.
 * POST /api/import — parse file, dedup, enqueue background processing via KV queue.
 * GET /api/import/status/:jobId — poll job progress.
 */

import type { App } from "@fresh/core";
import { parseBookmarkFile } from "../../lib/import-parsers.ts";
import {
  createImportJob,
  enqueueFirstBatch,
  getImportJob,
} from "../../lib/import-queue.ts";
import {
  BOOKMARK_COLLECTION,
  createAuthErrorResponse,
  getSessionFromRequest,
  setSessionCookie,
} from "../../lib/route-utils.ts";
import { getBaseUrl } from "../../shared/url-utils.ts";
import type {
  ImportedBookmark,
  ImportJob,
  ImportResponse,
  ImportStatusResponse,
} from "../../shared/types.ts";

const CHUNK_SIZE = 100;

export function registerImportRoutes(app: App<any>): App<any> {
  // POST /api/import — parse, dedup, enqueue for background processing
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
            { success: false, error: "No file provided" } as ImportResponse,
            { status: 400 },
          );
        }
        fileContent = await file.text();
      } catch {
        return Response.json(
          { success: false, error: "Invalid form data" } as ImportResponse,
          { status: 400 },
        );
      }

      if (!fileContent.trim()) {
        return Response.json(
          { success: false, error: "File is empty" } as ImportResponse,
          { status: 400 },
        );
      }

      // Parse the file
      let format: string;
      let bookmarks: ImportedBookmark[];
      try {
        const result = parseBookmarkFile(fileContent);
        format = result.format;
        bookmarks = result.bookmarks;
      } catch (err: any) {
        return Response.json(
          { success: false, error: err.message } as ImportResponse,
          { status: 400 },
        );
      }

      const total = bookmarks.length;
      if (total === 0) {
        const result: ImportResponse = {
          success: true,
          result: { imported: 0, skipped: 0, failed: 0, total: 0, format },
        };
        return setSessionCookie(Response.json(result), setCookieHeader);
      }

      // Fetch existing bookmarks for dedup (fast even for 10K — pagination only)
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
        const result: ImportResponse = {
          success: true,
          result: { imported: 0, skipped, failed: 0, total, format },
        };
        return setSessionCookie(Response.json(result), setCookieHeader);
      }

      // Split into chunks for background processing
      const chunks: ImportedBookmark[][] = [];
      for (let i = 0; i < newBookmarks.length; i += CHUNK_SIZE) {
        chunks.push(newBookmarks.slice(i, i + CHUNK_SIZE));
      }

      // Collect unique tags for creation after all chunks are processed
      const allTags = [...new Set(newBookmarks.flatMap((b) => b.tags))];

      // Create job in KV
      const jobId = crypto.randomUUID();
      const job: ImportJob = {
        status: "processing",
        total,
        imported: 0,
        skipped,
        failed: 0,
        format,
        totalChunks: chunks.length,
        processedChunks: 0,
      };

      await createImportJob(jobId, job, chunks, allTags);
      await enqueueFirstBatch(jobId, oauthSession.did);

      const result: ImportResponse = {
        success: true,
        jobId,
        result: { imported: 0, skipped, failed: 0, total, format },
      };
      return setSessionCookie(Response.json(result), setCookieHeader);
    } catch (error: any) {
      console.error("Import error:", error);
      return Response.json(
        { success: false, error: error.message } as ImportResponse,
        { status: 500 },
      );
    }
  });

  // GET /api/import/status/:jobId — poll job progress
  app = app.get("/api/import/status/:jobId", async (ctx) => {
    try {
      const { session: oauthSession, setCookieHeader, error } =
        await getSessionFromRequest(ctx.req);
      if (!oauthSession) {
        return createAuthErrorResponse(error);
      }

      const jobId = ctx.params.jobId;
      const job = await getImportJob(jobId);

      if (!job) {
        return Response.json(
          { error: "Job not found or expired" },
          { status: 404 },
        );
      }

      const progress = job.total > 0
        ? Math.round(
          ((job.imported + job.failed + job.skipped) / job.total) * 100,
        )
        : 100;

      const response: ImportStatusResponse = {
        status: job.status,
        imported: job.imported,
        skipped: job.skipped,
        failed: job.failed,
        total: job.total,
        format: job.format,
        progress,
      };

      return setSessionCookie(Response.json(response), setCookieHeader);
    } catch (error: any) {
      console.error("Import status error:", error);
      return Response.json({ error: error.message }, { status: 500 });
    }
  });

  return app;
}
