/**
 * Bookmark API routes.
 * Handles CRUD operations for user bookmarks stored on their PDS.
 * Enrichment metadata and notes are stored in annotation sidecar records.
 */

import type { App } from "@fresh/core";
import { extractUrlMetadata } from "../../lib/enrichment.ts";
import {
  extractRkey,
  fetchAnnotationMap,
  mapBookmarkRecord,
  writeAnnotation,
} from "../../lib/annotations.ts";
import {
  ANNOTATION_COLLECTION,
  BOOKMARK_COLLECTION,
  createAuthErrorResponse,
  createNewTagRecords,
  getSessionFromRequest,
  setSessionCookie,
} from "../../lib/route-utils.ts";
import { getUserSettings } from "../../lib/settings.ts";
import { sendToInstapaperAsync } from "../../lib/instapaper.ts";
import type {
  AddBookmarkRequest,
  AddBookmarkResponse,
  AnnotationRecord,
  CheckDuplicatesRequest,
  CheckDuplicatesResponse,
  EnrichedBookmark,
  ListBookmarksResponse,
  UpdateBookmarkTagsRequest,
  UpdateBookmarkTagsResponse,
} from "../../shared/types.ts";
import { getBaseUrl } from "../../shared/url-utils.ts";

export function registerBookmarkRoutes(app: App<any>): App<any> {
  // List bookmarks
  app = app.get("/api/bookmarks", async (ctx) => {
    try {
      const { session: oauthSession, setCookieHeader, error } =
        await getSessionFromRequest(ctx.req);
      if (!oauthSession) {
        return createAuthErrorResponse(error);
      }

      const params = new URLSearchParams({
        repo: oauthSession.did,
        collection: BOOKMARK_COLLECTION,
        limit: "100",
      });

      const [bookmarksResponse, annotationResult] = await Promise.all([
        oauthSession.makeRequest(
          "GET",
          `${oauthSession.pdsUrl}/xrpc/com.atproto.repo.listRecords?${params}`,
        ),
        fetchAnnotationMap(oauthSession),
      ]);

      if (!bookmarksResponse.ok) {
        const errorText = await bookmarksResponse.text();
        throw new Error(`Failed to list records: ${errorText}`);
      }

      const data = await bookmarksResponse.json();
      const bookmarks: EnrichedBookmark[] = data.records.map(
        (record: any) => {
          const rkey = extractRkey(record.uri);
          const annotation = rkey ? annotationResult.map.get(rkey) : undefined;
          return mapBookmarkRecord(record, annotation);
        },
      );

      const result: ListBookmarksResponse = { bookmarks };
      return setSessionCookie(Response.json(result), setCookieHeader);
    } catch (error: any) {
      console.error("Error listing bookmarks:", error);
      if (error.message?.includes("not found") || error.status === 400) {
        return Response.json({ bookmarks: [] });
      }
      return Response.json({ error: error.message }, { status: 500 });
    }
  });

  // Check for duplicate bookmarks by base URL
  app = app.post("/api/bookmarks/check-duplicates", async (ctx) => {
    try {
      const { session: oauthSession, setCookieHeader, error } =
        await getSessionFromRequest(ctx.req);
      if (!oauthSession) {
        return createAuthErrorResponse(error);
      }

      const body: CheckDuplicatesRequest = await ctx.req.json();
      if (!body.url) {
        return Response.json(
          { duplicates: [] } satisfies CheckDuplicatesResponse,
        );
      }

      const inputBase = getBaseUrl(body.url);
      if (!inputBase) {
        return Response.json(
          { duplicates: [] } satisfies CheckDuplicatesResponse,
        );
      }

      const params = new URLSearchParams({
        repo: oauthSession.did,
        collection: BOOKMARK_COLLECTION,
        limit: "100",
      });
      const response = await oauthSession.makeRequest(
        "GET",
        `${oauthSession.pdsUrl}/xrpc/com.atproto.repo.listRecords?${params}`,
      );

      if (!response.ok) {
        return setSessionCookie(
          Response.json(
            { duplicates: [] } satisfies CheckDuplicatesResponse,
          ),
          setCookieHeader,
        );
      }

      const data = await response.json();
      const duplicates: EnrichedBookmark[] = data.records
        .filter((record: any) => getBaseUrl(record.value.subject) === inputBase)
        .map((record: any) => mapBookmarkRecord(record));

      const result: CheckDuplicatesResponse = { duplicates };
      return setSessionCookie(Response.json(result), setCookieHeader);
    } catch {
      // Duplicate check is advisory — never block saving
      return Response.json(
        { duplicates: [] } satisfies CheckDuplicatesResponse,
      );
    }
  });

  // Add bookmark
  app = app.post("/api/bookmarks", async (ctx) => {
    try {
      const { session: oauthSession, setCookieHeader, error } =
        await getSessionFromRequest(ctx.req);
      if (!oauthSession) {
        return createAuthErrorResponse(error);
      }

      const body: AddBookmarkRequest = await ctx.req.json();
      if (!body.url) {
        return Response.json({ error: "URL is required" }, { status: 400 });
      }

      try {
        const url = new URL(body.url);
        if (!url.protocol.startsWith("http")) {
          return Response.json(
            { error: "Only HTTP(S) URLs are supported" },
            { status: 400 },
          );
        }
      } catch {
        return Response.json({ error: "Invalid URL format" }, { status: 400 });
      }

      // Validate optional tags
      let validatedTags: string[] = [];
      if (body.tags !== undefined) {
        if (!Array.isArray(body.tags)) {
          return Response.json(
            { error: "Tags must be an array" },
            { status: 400 },
          );
        }
        validatedTags = [
          ...new Set(
            body.tags
              .filter((t): t is string => typeof t === "string")
              .map((t) => t.trim())
              .filter((t) => t.length > 0 && t.length <= 64),
          ),
        ];
      }

      const metadata = await extractUrlMetadata(body.url);
      const createdAt = new Date().toISOString();

      // Write clean bookmark record (standard fields only)
      const record = { subject: body.url, createdAt, tags: validatedTags };

      const response = await oauthSession.makeRequest(
        "POST",
        `${oauthSession.pdsUrl}/xrpc/com.atproto.repo.createRecord`,
        {
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            repo: oauthSession.did,
            collection: BOOKMARK_COLLECTION,
            record,
          }),
        },
      );

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Failed to create record: ${errorText}`);
      }

      const data = await response.json();
      const rkey = extractRkey(data.uri);

      // Write annotation sidecar with same rkey (fire-and-forget on failure)
      if (rkey) {
        const annotation: AnnotationRecord = {
          subject: data.uri,
          title: metadata.title,
          description: metadata.description,
          favicon: metadata.favicon,
          image: metadata.image,
          createdAt,
        };
        writeAnnotation(oauthSession, rkey, annotation).catch((err) =>
          console.error("Failed to create annotation:", err)
        );
      }

      const bookmark: EnrichedBookmark = {
        uri: data.uri,
        cid: data.cid,
        subject: body.url,
        createdAt,
        tags: validatedTags,
        title: metadata.title,
        description: metadata.description,
        favicon: metadata.favicon,
        image: metadata.image,
      };

      // Create PDS tag records for new tags (non-blocking)
      if (validatedTags.length > 0) {
        createNewTagRecords(oauthSession, validatedTags).catch((err) =>
          console.error("Failed to create tag records:", err)
        );
      }

      const result: AddBookmarkResponse = { success: true, bookmark };
      return setSessionCookie(Response.json(result), setCookieHeader);
    } catch (error: any) {
      console.error("Error creating bookmark:", error);
      return Response.json({ error: error.message }, { status: 500 });
    }
  });

  // Update bookmark
  app = app.patch("/api/bookmarks/:rkey", async (ctx) => {
    try {
      const { session: oauthSession, setCookieHeader, error } =
        await getSessionFromRequest(ctx.req);
      if (!oauthSession) {
        return createAuthErrorResponse(error);
      }

      const rkey = ctx.params.rkey;
      const body: UpdateBookmarkTagsRequest = await ctx.req.json();

      if (!Array.isArray(body.tags)) {
        return Response.json(
          { error: "Tags must be an array" },
          { status: 400 },
        );
      }

      if (body.url) {
        try {
          const urlObj = new URL(body.url);
          if (!urlObj.protocol.startsWith("http")) {
            return Response.json(
              { error: "Only HTTP(S) URLs are supported" },
              { status: 400 },
            );
          }
        } catch {
          return Response.json(
            { error: "Invalid URL format" },
            { status: 400 },
          );
        }
      }

      // Get existing bookmark record
      const getParams = new URLSearchParams({
        repo: oauthSession.did,
        collection: BOOKMARK_COLLECTION,
        rkey,
      });
      const getResponse = await oauthSession.makeRequest(
        "GET",
        `${oauthSession.pdsUrl}/xrpc/com.atproto.repo.getRecord?${getParams}`,
      );

      if (!getResponse.ok) {
        const errorText = await getResponse.text();
        throw new Error(`Failed to get record: ${errorText}`);
      }

      const currentRecord = await getResponse.json();
      const bookmarkUri = currentRecord.uri;
      const subject = body.url || currentRecord.value.subject;

      // Write clean bookmark record (standard fields only)
      const record = {
        subject,
        createdAt: currentRecord.value.createdAt,
        tags: body.tags,
      };

      // Resolve enrichment: prefer body values, then $enriched fallback
      const existing = currentRecord.value.$enriched || {};
      const title = body.title !== undefined ? body.title : existing.title;
      const description = body.description !== undefined
        ? body.description
        : existing.description;

      // Write annotation sidecar with enrichment + note
      const annotation: AnnotationRecord = {
        subject: bookmarkUri,
        title,
        description,
        favicon: existing.favicon,
        image: existing.image,
        note: body.note,
        createdAt: currentRecord.value.createdAt,
      };

      // Run bookmark write, annotation write, and settings fetch in parallel
      const [putResult, annotationWritten, settings] = await Promise.all([
        oauthSession.makeRequest(
          "POST",
          `${oauthSession.pdsUrl}/xrpc/com.atproto.repo.putRecord`,
          {
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              repo: oauthSession.did,
              collection: BOOKMARK_COLLECTION,
              rkey,
              record,
            }),
          },
        ),
        writeAnnotation(oauthSession, rkey, annotation),
        getUserSettings(oauthSession.did),
      ]);

      if (!putResult.ok) {
        const errorText = await putResult.text();
        throw new Error(`Failed to update record: ${errorText}`);
      }

      const data = await putResult.json();

      // If annotation write failed (old scope), fall back to $enriched
      if (!annotationWritten) {
        console.warn("Annotation write failed, falling back to $enriched");
        const fallback = {
          ...record,
          $enriched: {
            title,
            description,
            favicon: existing.favicon,
            image: existing.image,
          },
        };
        await oauthSession.makeRequest(
          "POST",
          `${oauthSession.pdsUrl}/xrpc/com.atproto.repo.putRecord`,
          {
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              repo: oauthSession.did,
              collection: BOOKMARK_COLLECTION,
              rkey,
              record: fallback,
            }),
          },
        ).catch(() => {});
      }

      const bookmark: EnrichedBookmark = {
        uri: data.uri,
        cid: data.cid,
        subject,
        createdAt: record.createdAt,
        tags: record.tags,
        title,
        description,
        favicon: existing.favicon,
        image: existing.image,
        note: body.note,
      };

      const hasReadingListTag = record.tags.includes(settings.readingListTag);
      const hadReadingListTag =
        currentRecord.value.tags?.includes(settings.readingListTag) || false;

      if (
        settings.instapaperEnabled && hasReadingListTag && !hadReadingListTag
      ) {
        sendToInstapaperAsync(oauthSession.did, subject, title).catch(
          (err) => console.error("Failed to send bookmark to Instapaper:", err),
        );
      }

      const result: UpdateBookmarkTagsResponse = { success: true, bookmark };
      return setSessionCookie(Response.json(result), setCookieHeader);
    } catch (error: any) {
      console.error("Error updating bookmark tags:", error);
      return Response.json({ error: error.message }, { status: 500 });
    }
  });

  // Re-enrich bookmark (refresh metadata from URL)
  app = app.post("/api/bookmarks/:rkey/enrich", async (ctx) => {
    try {
      const { session: oauthSession, setCookieHeader, error } =
        await getSessionFromRequest(ctx.req);
      if (!oauthSession) {
        return createAuthErrorResponse(error);
      }

      const rkey = ctx.params.rkey;

      const getParams = new URLSearchParams({
        repo: oauthSession.did,
        collection: BOOKMARK_COLLECTION,
        rkey,
      });
      const getResponse = await oauthSession.makeRequest(
        "GET",
        `${oauthSession.pdsUrl}/xrpc/com.atproto.repo.getRecord?${getParams}`,
      );

      if (!getResponse.ok) {
        const errorText = await getResponse.text();
        throw new Error(`Failed to get record: ${errorText}`);
      }

      const currentRecord = await getResponse.json();
      const metadata = await extractUrlMetadata(currentRecord.value.subject);

      // Preserve existing note from annotation
      let existingNote: string | undefined;
      try {
        const annParams = new URLSearchParams({
          repo: oauthSession.did,
          collection: ANNOTATION_COLLECTION,
          rkey,
        });
        const annRes = await oauthSession.makeRequest(
          "GET",
          `${oauthSession.pdsUrl}/xrpc/com.atproto.repo.getRecord?${annParams}`,
        );
        if (annRes.ok) {
          existingNote = (await annRes.json()).value?.note;
        }
      } catch { /* no annotation yet */ }

      // Write to annotation sidecar
      const annotation: AnnotationRecord = {
        subject: currentRecord.uri,
        title: metadata.title,
        description: metadata.description,
        favicon: metadata.favicon,
        image: metadata.image,
        note: existingNote,
        createdAt: currentRecord.value.createdAt,
      };

      const ok = await writeAnnotation(oauthSession, rkey, annotation);

      // Fallback to $enriched on bookmark
      if (!ok) {
        const record = {
          ...currentRecord.value,
          $enriched: {
            title: metadata.title,
            description: metadata.description,
            favicon: metadata.favicon,
            image: metadata.image,
          },
        };
        await oauthSession.makeRequest(
          "POST",
          `${oauthSession.pdsUrl}/xrpc/com.atproto.repo.putRecord`,
          {
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              repo: oauthSession.did,
              collection: BOOKMARK_COLLECTION,
              rkey,
              record,
            }),
          },
        );
      }

      const bookmark: EnrichedBookmark = {
        uri: currentRecord.uri,
        cid: currentRecord.cid,
        subject: currentRecord.value.subject,
        createdAt: currentRecord.value.createdAt,
        tags: currentRecord.value.tags || [],
        title: metadata.title,
        description: metadata.description,
        favicon: metadata.favicon,
        image: metadata.image,
        note: existingNote,
      };

      return setSessionCookie(
        Response.json({ success: true, bookmark }),
        setCookieHeader,
      );
    } catch (error: any) {
      console.error("Error re-enriching bookmark:", error);
      return Response.json({ error: error.message }, { status: 500 });
    }
  });

  // Delete bookmark
  app = app.delete("/api/bookmarks/:rkey", async (ctx) => {
    try {
      const { session: oauthSession, setCookieHeader, error } =
        await getSessionFromRequest(ctx.req);
      if (!oauthSession) {
        return createAuthErrorResponse(error);
      }

      const rkey = ctx.params.rkey;

      const response = await oauthSession.makeRequest(
        "POST",
        `${oauthSession.pdsUrl}/xrpc/com.atproto.repo.deleteRecord`,
        {
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            repo: oauthSession.did,
            collection: BOOKMARK_COLLECTION,
            rkey,
          }),
        },
      );

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Failed to delete record: ${errorText}`);
      }

      // Also delete annotation sidecar (fire-and-forget)
      oauthSession.makeRequest(
        "POST",
        `${oauthSession.pdsUrl}/xrpc/com.atproto.repo.deleteRecord`,
        {
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            repo: oauthSession.did,
            collection: ANNOTATION_COLLECTION,
            rkey,
          }),
        },
      ).catch(() => {});

      return setSessionCookie(
        Response.json({ success: true }),
        setCookieHeader,
      );
    } catch (error: any) {
      console.error("Error deleting bookmark:", error);
      return Response.json({ error: error.message }, { status: 500 });
    }
  });

  return app;
}
