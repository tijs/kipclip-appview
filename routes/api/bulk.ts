/**
 * Bulk operations API route.
 * Handles batch delete, add-tags, and remove-tags operations for bookmarks.
 */

import type { App } from "@fresh/core";
import { extractRkey, mapBookmarkRecord } from "../../lib/annotations.ts";
import {
  ANNOTATION_COLLECTION,
  BOOKMARK_COLLECTION,
  createAuthErrorResponse,
  createNewTagRecords,
  getSessionFromRequest,
  setSessionCookie,
} from "../../lib/route-utils.ts";
import type {
  AnnotationRecord,
  BulkOperationRequest,
  BulkOperationResponse,
  EnrichedBookmark,
} from "../../shared/types.ts";

const MAX_WRITES = 10;

export function registerBulkRoutes(app: App<any>): App<any> {
  app = app.post("/api/bookmarks/bulk", async (ctx) => {
    try {
      const { session: oauthSession, setCookieHeader, error } =
        await getSessionFromRequest(ctx.req);
      if (!oauthSession) {
        return createAuthErrorResponse(error);
      }

      const body: BulkOperationRequest = await ctx.req.json();

      if (!body.action || !Array.isArray(body.uris) || body.uris.length === 0) {
        return Response.json(
          { error: "action and uris[] are required" },
          { status: 400 },
        );
      }

      if (
        (body.action === "add-tags" || body.action === "remove-tags") &&
        (!Array.isArray(body.tags) || body.tags.length === 0)
      ) {
        return Response.json(
          { error: "tags[] is required for tag operations" },
          { status: 400 },
        );
      }

      let result: BulkOperationResponse;

      switch (body.action) {
        case "delete":
          result = await bulkDelete(oauthSession, body.uris);
          break;
        case "add-tags":
          result = await bulkUpdateTags(
            oauthSession,
            body.uris,
            body.tags!,
            "add",
          );
          break;
        case "remove-tags":
          result = await bulkUpdateTags(
            oauthSession,
            body.uris,
            body.tags!,
            "remove",
          );
          break;
        default:
          return Response.json(
            { error: "Invalid action" },
            { status: 400 },
          );
      }

      return setSessionCookie(Response.json(result), setCookieHeader);
    } catch (error: any) {
      console.error("Bulk operation error:", error);
      return Response.json({ error: error.message }, { status: 500 });
    }
  });

  return app;
}

/**
 * Bulk delete bookmarks via applyWrites batches.
 * Annotation sidecar deletes are fire-and-forget.
 */
async function bulkDelete(
  oauthSession: any,
  uris: string[],
): Promise<BulkOperationResponse> {
  const did = oauthSession.did;
  const rkeys = uris.map((uri) => extractRkey(uri)).filter(Boolean) as string[];

  // Build delete operations for bookmarks
  const deleteOps = rkeys.map((rkey) => ({
    $type: "com.atproto.repo.applyWrites#delete",
    collection: BOOKMARK_COLLECTION,
    rkey,
  }));

  // Batch into groups of MAX_WRITES
  let succeeded = 0;
  let failed = 0;
  const errors: string[] = [];

  for (let i = 0; i < deleteOps.length; i += MAX_WRITES) {
    const batch = deleteOps.slice(i, i + MAX_WRITES);
    try {
      const res = await oauthSession.makeRequest(
        "POST",
        `${oauthSession.pdsUrl}/xrpc/com.atproto.repo.applyWrites`,
        {
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ repo: did, writes: batch }),
        },
      );

      if (res.ok) {
        succeeded += batch.length;
      } else {
        const errorText = await res.text();
        console.error("Bulk delete batch failed:", errorText);
        failed += batch.length;
        errors.push(`Batch failed: ${errorText}`);
      }
    } catch (err: any) {
      console.error("Bulk delete batch error:", err);
      failed += batch.length;
      errors.push(`Batch error: ${err.message}`);
    }
  }

  // Fire-and-forget: delete annotation sidecars
  const annotationOps = rkeys.map((rkey) => ({
    $type: "com.atproto.repo.applyWrites#delete",
    collection: ANNOTATION_COLLECTION,
    rkey,
  }));

  for (let i = 0; i < annotationOps.length; i += MAX_WRITES) {
    const batch = annotationOps.slice(i, i + MAX_WRITES);
    oauthSession.makeRequest(
      "POST",
      `${oauthSession.pdsUrl}/xrpc/com.atproto.repo.applyWrites`,
      {
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repo: did, writes: batch }),
      },
    ).catch(() => {});
  }

  return {
    success: failed === 0,
    succeeded,
    failed,
    errors: errors.length > 0 ? errors : undefined,
  };
}

/**
 * Bulk update tags on bookmarks.
 * Fetches each bookmark, modifies tags, writes back via putRecord.
 * Returns updated EnrichedBookmark[] for frontend state sync.
 */
async function bulkUpdateTags(
  oauthSession: any,
  uris: string[],
  tags: string[],
  mode: "add" | "remove",
): Promise<BulkOperationResponse> {
  let succeeded = 0;
  let failed = 0;
  const errors: string[] = [];
  const updatedBookmarks: EnrichedBookmark[] = [];

  // Process bookmarks with concurrency limit
  const CONCURRENCY = 5;
  for (let i = 0; i < uris.length; i += CONCURRENCY) {
    const batch = uris.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map((uri) =>
        updateBookmarkTags(oauthSession, uri, tags, mode)
      ),
    );

    for (const result of results) {
      if (result.status === "fulfilled" && result.value) {
        succeeded++;
        updatedBookmarks.push(result.value);
      } else {
        failed++;
        const reason = result.status === "rejected"
          ? result.reason?.message
          : "Unknown error";
        errors.push(reason);
      }
    }
  }

  // Create new tag records if adding tags
  if (mode === "add" && succeeded > 0) {
    await createNewTagRecords(oauthSession, tags).catch((err) =>
      console.error("Failed to create tag records:", err)
    );
  }

  return {
    success: failed === 0,
    succeeded,
    failed,
    errors: errors.length > 0 ? errors : undefined,
    bookmarks: updatedBookmarks,
  };
}

/**
 * Update tags on a single bookmark record.
 * Fetches the current record, modifies tags, writes back.
 */
async function updateBookmarkTags(
  oauthSession: any,
  uri: string,
  tags: string[],
  mode: "add" | "remove",
): Promise<EnrichedBookmark | null> {
  const rkey = extractRkey(uri);
  if (!rkey) throw new Error(`Invalid URI: ${uri}`);

  // Fetch current bookmark and annotation in parallel
  const bookmarkParams = new URLSearchParams({
    repo: oauthSession.did,
    collection: BOOKMARK_COLLECTION,
    rkey,
  });
  const annParams = new URLSearchParams({
    repo: oauthSession.did,
    collection: ANNOTATION_COLLECTION,
    rkey,
  });

  const [getResponse, annRes] = await Promise.all([
    oauthSession.makeRequest(
      "GET",
      `${oauthSession.pdsUrl}/xrpc/com.atproto.repo.getRecord?${bookmarkParams}`,
    ),
    oauthSession.makeRequest(
      "GET",
      `${oauthSession.pdsUrl}/xrpc/com.atproto.repo.getRecord?${annParams}`,
    ).catch(() => null),
  ]);

  if (!getResponse.ok) {
    throw new Error(`Failed to get bookmark: ${await getResponse.text()}`);
  }

  const currentRecord = await getResponse.json();
  const currentTags: string[] = currentRecord.value.tags || [];

  // Compute new tags
  let newTags: string[];
  if (mode === "add") {
    const tagSet = new Set(currentTags);
    for (const tag of tags) tagSet.add(tag);
    newTags = [...tagSet];
  } else {
    const removeSet = new Set(tags);
    newTags = currentTags.filter((t) => !removeSet.has(t));
  }

  // Write updated bookmark record
  const record = {
    subject: currentRecord.value.subject,
    createdAt: currentRecord.value.createdAt,
    tags: newTags,
  };

  const putResult = await oauthSession.makeRequest(
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

  if (!putResult.ok) {
    throw new Error(`Failed to update bookmark: ${await putResult.text()}`);
  }

  const putData = await putResult.json();

  // Build enriched bookmark from annotation data
  let annotation: AnnotationRecord | undefined;
  if (annRes?.ok) {
    annotation = (await annRes.json()).value as AnnotationRecord;
  }

  return mapBookmarkRecord({ ...putData, value: record }, annotation);
}
