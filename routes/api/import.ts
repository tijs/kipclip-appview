/**
 * Import API route.
 * POST /api/import — parse file, dedup, process bookmarks synchronously.
 */

import type { App } from "@fresh/core";
import { parseBookmarkFile } from "../../lib/import-parsers.ts";
import {
  ANNOTATION_COLLECTION,
  BOOKMARK_COLLECTION,
  createAuthErrorResponse,
  createNewTagRecords,
  getSessionFromRequest,
  setSessionCookie,
} from "../../lib/route-utils.ts";
import { getBaseUrl } from "../../shared/url-utils.ts";
import type { ImportedBookmark, ImportResponse } from "../../shared/types.ts";

const BATCH_SIZE = 200;

export function registerImportRoutes(app: App<any>): App<any> {
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
        const result: ImportResponse = {
          success: true,
          result: { imported: 0, skipped, failed: 0, total, format },
        };
        return setSessionCookie(Response.json(result), setCookieHeader);
      }

      // Process all bookmarks synchronously via applyWrites batching
      let imported = 0;
      let failed = 0;
      const did = oauthSession.did;

      for (let i = 0; i < newBookmarks.length; i += BATCH_SIZE) {
        const batch = newBookmarks.slice(i, i + BATCH_SIZE);
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
            imported += batch.length;
          } else {
            const errorText = await res.text();
            console.error(`Import applyWrites failed: ${errorText}`);
            failed += batch.length;
          }
        } catch (err) {
          console.error("Import applyWrites error:", err);
          failed += batch.length;
        }
      }

      // Create tag records for any new tags
      const allTags = [...new Set(newBookmarks.flatMap((b) => b.tags))];
      if (allTags.length > 0) {
        await createNewTagRecords(oauthSession, allTags).catch((err) =>
          console.error("Failed to create tag records during import:", err)
        );
      }

      const result: ImportResponse = {
        success: true,
        result: { imported, skipped, failed, total, format },
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

  return app;
}
