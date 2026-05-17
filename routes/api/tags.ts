/**
 * Tag API routes.
 * Handles CRUD operations for user tags stored on their PDS.
 */

import type { App } from "@fresh/core";
import {
  BOOKMARK_COLLECTION,
  createAuthErrorResponse,
  fetchOwnerBookmarkRecords,
  fetchOwnerTagRecord,
  fetchOwnerTagRecords,
  getSessionFromRequest,
  isInvalidSwap,
  listAllRecords,
  setSessionCookie,
  TAG_COLLECTION,
} from "../../lib/route-utils.ts";
import type {
  AddTagRequest,
  AddTagResponse,
  DeleteTagResponse,
  EnrichedTag,
  ListTagsResponse,
  UpdateTagRequest,
  UpdateTagResponse,
} from "../../shared/types.ts";
import { tagIncludes, tagsEqual } from "../../shared/tag-utils.ts";
import { mergeTagDuplicates } from "../../lib/migration-merge-tags.ts";
import { shouldReadFromMirror } from "../../lib/mirror-config.ts";
import { listTags as listMirrorTags } from "../../mirror/queries.ts";
import { deleteTag, upsertTag } from "../../mirror/upserts.ts";
import { captureMessage } from "../../lib/sentry.ts";
import { createTimer } from "../../lib/server-timing.ts";
import {
  getCachedTags,
  invalidateCachedTags,
  setCachedTags,
} from "../../lib/tag-cache.ts";

export function registerTagRoutes(app: App<any>): App<any> {
  // List tags. Reads from mirror when MIRROR_MODE=read and the DID is tracked
  // with a populated mirror; otherwise falls through to the PDS.
  app = app.get("/api/tags", async (ctx) => {
    const timer = createTimer();
    try {
      const { session: oauthSession, setCookieHeader, error } = await timer
        .span("session", () => getSessionFromRequest(ctx.req));
      if (!oauthSession) {
        return createAuthErrorResponse(error);
      }

      const decision = await timer.span(
        "mirror-decision",
        () => shouldReadFromMirror(oauthSession.did),
      );
      if (decision.fromMirror) {
        try {
          const tags = await timer.span(
            "mirror-tags",
            () => listMirrorTags(oauthSession.did),
          );
          // Safeguard: a backfill-complete mirror with 0 tags is suspicious —
          // the user may have tags on PDS that TAP hasn't delivered yet (e.g.
          // TAP enrollment lag, or tags created via bookmark inline-create before
          // mirror-write was added). Fall through to PDS so the sidebar is never
          // empty when the user actually has tags.
          if (tags.length === 0) {
            captureMessage(
              "mirror empty safeguard: falling through to PDS",
              "debug",
              { did: oauthSession.did, op: "GET /api/tags" },
            );
            throw new Error("mirror_empty_fallthrough");
          }
          const result: ListTagsResponse = { tags };
          return timer.finalize(
            setSessionCookie(Response.json(result), setCookieHeader),
          );
        } catch (mirrorErr) {
          if (
            !(mirrorErr instanceof Error &&
              mirrorErr.message === "mirror_empty_fallthrough")
          ) {
            captureMessage(
              "mirror read fallback to PDS",
              "warning",
              {
                did: oauthSession.did,
                op: "GET /api/tags",
                error: String(mirrorErr),
              },
            );
          }
          // Fall through to the PDS path below — gives the user real tags
          // instead of an empty sidebar when the DB fails briefly.
          // Do NOT serve the PDS cache here: mirror users may have newer data
          // that was written since the cache was populated.
        }
      }

      // PDS cache: only serve to untracked users. Mirror users who fell through
      // above need a fresh PDS fetch, not a snapshot that predates TAP delivery.
      if (!decision.fromMirror) {
        const cached = getCachedTags(oauthSession.did);
        if (cached) {
          return timer.finalize(
            setSessionCookie(
              Response.json({ tags: cached } as ListTagsResponse),
              setCookieHeader,
            ),
          );
        }
      }

      const records = await timer.span(
        "pds-tags",
        () => listAllRecords(oauthSession, TAG_COLLECTION),
      );
      const tags: EnrichedTag[] = records.map((record: any) => ({
        uri: record.uri,
        cid: record.cid,
        value: record.value.value,
        createdAt: record.value.createdAt,
      }));
      if (!decision.fromMirror) {
        setCachedTags(oauthSession.did, tags);
      }

      const result: ListTagsResponse = { tags };
      return timer.finalize(
        setSessionCookie(Response.json(result), setCookieHeader),
      );
    } catch (error: any) {
      console.error("Error listing tags:", error);
      if (error.message?.includes("not found") || error.status === 400) {
        return Response.json({ tags: [] });
      }
      return Response.json({ error: error.message }, { status: 500 });
    }
  });

  // Add tag
  app = app.post("/api/tags", async (ctx) => {
    try {
      const { session: oauthSession, setCookieHeader, error } =
        await getSessionFromRequest(ctx.req);
      if (!oauthSession) {
        return createAuthErrorResponse(error);
      }

      const body: AddTagRequest = await ctx.req.json();
      if (!body.value || typeof body.value !== "string") {
        return Response.json(
          { error: "Tag value is required" },
          { status: 400 },
        );
      }

      const value = body.value.trim();
      if (value.length === 0) {
        return Response.json({ error: "Tag value cannot be empty" }, {
          status: 400,
        });
      }
      if (value.length > 64) {
        return Response.json(
          { error: "Tag value must be 64 characters or less" },
          { status: 400 },
        );
      }

      // Check if a tag with this value already exists (case-insensitive)
      const existingRecords = await fetchOwnerTagRecords(oauthSession);
      const existing = existingRecords.find((rec: any) =>
        tagsEqual(rec.value?.value ?? "", value)
      );
      if (existing) {
        const tag: EnrichedTag = {
          uri: existing.uri,
          cid: existing.cid,
          value: existing.value.value,
          createdAt: existing.value.createdAt,
        };
        return setSessionCookie(
          Response.json({ success: true, tag } as AddTagResponse),
          setCookieHeader,
        );
      }

      const record = {
        value: value,
        createdAt: new Date().toISOString(),
      };

      const response = await oauthSession.makeRequest(
        "POST",
        `${oauthSession.pdsUrl}/xrpc/com.atproto.repo.createRecord`,
        {
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            repo: oauthSession.did,
            collection: TAG_COLLECTION,
            record,
          }),
        },
      );

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Failed to create record: ${errorText}`);
      }

      const data = await response.json();
      const tag: EnrichedTag = {
        uri: data.uri,
        cid: data.cid,
        value: value,
        createdAt: record.createdAt,
      };

      // Write to mirror so the tag is immediately visible when the DID is
      // tracked — TAP delivery can lag seconds after PDS write. Awaiting the
      // local SQLite write (sub-ms) ensures mirror users see the new tag on the
      // next GET /api/tags before we return.
      invalidateCachedTags(oauthSession.did);
      await upsertTag({
        uri: data.uri,
        did: oauthSession.did,
        rkey: data.uri.split("/").pop() ?? "",
        cid: data.cid,
        value,
        createdAt: record.createdAt,
      }).catch((err) =>
        captureMessage("tag mirror-write failed", "warning", {
          op: "POST /api/tags",
          did: oauthSession.did,
          error: String(err),
        })
      );

      const result: AddTagResponse = { success: true, tag };
      return setSessionCookie(Response.json(result), setCookieHeader);
    } catch (error: any) {
      console.error("Error creating tag:", error);
      return Response.json({ error: error.message }, { status: 500 });
    }
  });

  // Update tag
  app = app.put("/api/tags/:rkey", async (ctx) => {
    try {
      const { session: oauthSession, setCookieHeader, error } =
        await getSessionFromRequest(ctx.req);
      if (!oauthSession) {
        return createAuthErrorResponse(error);
      }

      const rkey = ctx.params.rkey;
      const body: UpdateTagRequest = await ctx.req.json();

      if (!body.value || typeof body.value !== "string") {
        return Response.json(
          { error: "Tag value is required" },
          { status: 400 },
        );
      }

      const newValue = body.value.trim();
      if (newValue.length === 0) {
        return Response.json({ error: "Tag value cannot be empty" }, {
          status: 400,
        });
      }
      if (newValue.length > 64) {
        return Response.json(
          { error: "Tag value must be 64 characters or less" },
          { status: 400 },
        );
      }

      // Get current record (mirror-aware, PDS fallback on miss/error)
      const currentRecord = await fetchOwnerTagRecord(oauthSession, rkey);
      if (!currentRecord) {
        throw new Error(`Failed to get record: tag ${rkey} not found`);
      }
      const oldValue = currentRecord.value.value;

      // If value hasn't changed (exact match), return success
      if (oldValue === newValue) {
        const tag: EnrichedTag = {
          uri: currentRecord.uri,
          cid: currentRecord.cid,
          value: newValue,
          createdAt: currentRecord.value.createdAt,
        };
        return setSessionCookie(
          Response.json({ success: true, tag }),
          setCookieHeader,
        );
      }

      // Check for case-insensitive collision with another tag
      const allTagRecords = await fetchOwnerTagRecords(oauthSession);
      const collision = allTagRecords.find((rec: any) =>
        tagsEqual(rec.value?.value ?? "", newValue) &&
        rec.uri !== currentRecord.uri
      );
      if (collision) {
        return Response.json(
          { error: `A tag "${collision.value.value}" already exists` },
          { status: 409 },
        );
      }

      // Update bookmarks with the old tag value (case-insensitive match)
      const bookmarkRecords = await fetchOwnerBookmarkRecords(oauthSession);

      await Promise.all(
        bookmarkRecords
          .filter((record: any) =>
            tagIncludes(record.value.tags || [], oldValue)
          )
          .map(async (record: any) => {
            const bookmarkRkey = record.uri.split("/").pop();
            const updatedTags = record.value.tags.map((t: string) =>
              tagsEqual(t, oldValue) ? newValue : t
            );

            const res = await oauthSession.makeRequest(
              "POST",
              `${oauthSession.pdsUrl}/xrpc/com.atproto.repo.putRecord`,
              {
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  repo: oauthSession.did,
                  collection: BOOKMARK_COLLECTION,
                  rkey: bookmarkRkey,
                  record: { ...record.value, tags: updatedTags },
                }),
              },
            );

            if (!res.ok) {
              console.error(
                `Failed to update bookmark ${bookmarkRkey}:`,
                await res.text(),
              );
            }
          }),
      );

      // Update the tag record
      const record = {
        value: newValue,
        createdAt: currentRecord.value.createdAt,
      };

      const updateResponse = await oauthSession.makeRequest(
        "POST",
        `${oauthSession.pdsUrl}/xrpc/com.atproto.repo.putRecord`,
        {
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            repo: oauthSession.did,
            collection: TAG_COLLECTION,
            rkey,
            record,
            swapRecord: currentRecord.cid,
          }),
        },
      );

      if (!updateResponse.ok) {
        const errorText = await updateResponse.text();
        if (isInvalidSwap(updateResponse.status, errorText)) {
          return Response.json(
            {
              error: "concurrent_edit",
              message:
                "This tag was modified by another tab or device. Refresh and try again.",
            },
            { status: 409 },
          );
        }
        throw new Error(`Failed to update tag record: ${errorText}`);
      }

      const data = await updateResponse.json();
      const tag: EnrichedTag = {
        uri: data.uri,
        cid: data.cid,
        value: newValue,
        createdAt: record.createdAt,
      };

      invalidateCachedTags(oauthSession.did);
      await upsertTag({
        uri: data.uri,
        did: oauthSession.did,
        rkey,
        cid: data.cid,
        value: newValue,
        createdAt: record.createdAt,
      }).catch((err) =>
        captureMessage("tag mirror-write failed", "warning", {
          op: "PUT /api/tags/:rkey",
          did: oauthSession.did,
          error: String(err),
        })
      );

      const result: UpdateTagResponse = { success: true, tag };
      return setSessionCookie(Response.json(result), setCookieHeader);
    } catch (error: any) {
      console.error("Error updating tag:", error);
      return Response.json({ error: error.message }, { status: 500 });
    }
  });

  // Get tag usage
  app = app.get("/api/tags/:rkey/usage", async (ctx) => {
    try {
      const { session: oauthSession, setCookieHeader, error } =
        await getSessionFromRequest(ctx.req);
      if (!oauthSession) {
        return createAuthErrorResponse(error);
      }

      const rkey = ctx.params.rkey;

      // Get the tag (mirror-aware, PDS fallback on miss/error)
      const tagData = await fetchOwnerTagRecord(oauthSession, rkey);
      if (!tagData) {
        throw new Error(`Failed to get tag: tag ${rkey} not found`);
      }
      const tagValue = tagData.value.value;

      // List all bookmarks
      const bookmarkRecords = await fetchOwnerBookmarkRecords(oauthSession);
      const count = bookmarkRecords.filter((record: any) =>
        tagIncludes(record.value.tags || [], tagValue)
      ).length;

      return setSessionCookie(
        Response.json({ count, tagValue }),
        setCookieHeader,
      );
    } catch (error: any) {
      console.error("Error getting tag usage:", error);
      return Response.json({ error: error.message }, { status: 500 });
    }
  });

  // Delete tag
  app = app.delete("/api/tags/:rkey", async (ctx) => {
    try {
      const { session: oauthSession, setCookieHeader, error } =
        await getSessionFromRequest(ctx.req);
      if (!oauthSession) {
        return createAuthErrorResponse(error);
      }

      const rkey = ctx.params.rkey;

      // Get the tag (mirror-aware, PDS fallback on miss/error)
      const tagData = await fetchOwnerTagRecord(oauthSession, rkey);
      if (!tagData) {
        throw new Error(`Failed to get tag: tag ${rkey} not found`);
      }
      const tagValue = tagData.value.value;

      // Remove tag from all bookmarks
      const bookmarkRecords = await fetchOwnerBookmarkRecords(oauthSession);

      await Promise.all(
        bookmarkRecords
          .filter((record: any) =>
            tagIncludes(record.value.tags || [], tagValue)
          )
          .map(async (record: any) => {
            const bookmarkRkey = record.uri.split("/").pop();
            const updatedTags = record.value.tags.filter((t: string) =>
              !tagsEqual(t, tagValue)
            );

            const res = await oauthSession.makeRequest(
              "POST",
              `${oauthSession.pdsUrl}/xrpc/com.atproto.repo.putRecord`,
              {
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  repo: oauthSession.did,
                  collection: BOOKMARK_COLLECTION,
                  rkey: bookmarkRkey,
                  record: { ...record.value, tags: updatedTags },
                }),
              },
            );

            if (!res.ok) {
              console.error(
                `Failed to update bookmark ${bookmarkRkey}:`,
                await res.text(),
              );
            }
          }),
      );

      // Delete the tag record
      const deleteResponse = await oauthSession.makeRequest(
        "POST",
        `${oauthSession.pdsUrl}/xrpc/com.atproto.repo.deleteRecord`,
        {
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            repo: oauthSession.did,
            collection: TAG_COLLECTION,
            rkey,
          }),
        },
      );

      if (!deleteResponse.ok) {
        const errorText = await deleteResponse.text();
        throw new Error(`Failed to delete tag record: ${errorText}`);
      }

      invalidateCachedTags(oauthSession.did);
      await deleteTag(
        `at://${oauthSession.did}/${TAG_COLLECTION}/${rkey}`,
        oauthSession.did,
      ).catch((err) =>
        captureMessage("tag mirror-write failed", "warning", {
          op: "DELETE /api/tags/:rkey",
          did: oauthSession.did,
          error: String(err),
        })
      );

      const result: DeleteTagResponse = { success: true };
      return setSessionCookie(Response.json(result), setCookieHeader);
    } catch (error: any) {
      console.error("Error deleting tag:", error);
      const result: DeleteTagResponse = {
        success: false,
        error: error.message,
      };
      return Response.json(result, { status: 500 });
    }
  });

  // Merge duplicate tags (case-insensitive migration)
  app = app.post("/api/tags/merge-duplicates", async (ctx) => {
    try {
      const { session: oauthSession, setCookieHeader, error } =
        await getSessionFromRequest(ctx.req);
      if (!oauthSession) {
        return createAuthErrorResponse(error);
      }

      const [tagRecords, bookmarkRecords] = await Promise.all([
        fetchOwnerTagRecords(oauthSession),
        fetchOwnerBookmarkRecords(oauthSession),
      ]);

      const result = await mergeTagDuplicates(
        oauthSession,
        tagRecords,
        bookmarkRecords,
      );
      invalidateCachedTags(oauthSession.did);
      return setSessionCookie(Response.json(result), setCookieHeader);
    } catch (error: any) {
      console.error("Error merging duplicate tags:", error);
      return Response.json({ error: error.message }, { status: 500 });
    }
  });

  return app;
}
