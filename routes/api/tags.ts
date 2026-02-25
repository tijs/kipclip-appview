/**
 * Tag API routes.
 * Handles CRUD operations for user tags stored on their PDS.
 */

import type { App } from "@fresh/core";
import {
  BOOKMARK_COLLECTION,
  createAuthErrorResponse,
  getSessionFromRequest,
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

export function registerTagRoutes(app: App<any>): App<any> {
  // List tags
  app = app.get("/api/tags", async (ctx) => {
    try {
      const { session: oauthSession, setCookieHeader, error } =
        await getSessionFromRequest(ctx.req);
      if (!oauthSession) {
        return createAuthErrorResponse(error);
      }

      const records = await listAllRecords(oauthSession, TAG_COLLECTION);
      const tags: EnrichedTag[] = records.map((record: any) => ({
        uri: record.uri,
        cid: record.cid,
        value: record.value.value,
        createdAt: record.value.createdAt,
      }));

      const result: ListTagsResponse = { tags };
      return setSessionCookie(Response.json(result), setCookieHeader);
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

      // Get current record
      const getParams = new URLSearchParams({
        repo: oauthSession.did,
        collection: TAG_COLLECTION,
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
      const oldValue = currentRecord.value.value;

      // If value hasn't changed, return success
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

      // Update bookmarks with the old tag value
      const bookmarkRecords = await listAllRecords(
        oauthSession,
        BOOKMARK_COLLECTION,
      );

      await Promise.all(
        bookmarkRecords
          .filter((record: any) => record.value.tags?.includes(oldValue))
          .map(async (record: any) => {
            const bookmarkRkey = record.uri.split("/").pop();
            const updatedTags = record.value.tags.map((t: string) =>
              t === oldValue ? newValue : t
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
          }),
        },
      );

      if (!updateResponse.ok) {
        const errorText = await updateResponse.text();
        throw new Error(`Failed to update tag record: ${errorText}`);
      }

      const data = await updateResponse.json();
      const tag: EnrichedTag = {
        uri: data.uri,
        cid: data.cid,
        value: newValue,
        createdAt: record.createdAt,
      };

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

      // Get the tag
      const getParams = new URLSearchParams({
        repo: oauthSession.did,
        collection: TAG_COLLECTION,
        rkey,
      });
      const getResponse = await oauthSession.makeRequest(
        "GET",
        `${oauthSession.pdsUrl}/xrpc/com.atproto.repo.getRecord?${getParams}`,
      );

      if (!getResponse.ok) {
        const errorText = await getResponse.text();
        throw new Error(`Failed to get tag: ${errorText}`);
      }

      const tagData = await getResponse.json();
      const tagValue = tagData.value.value;

      // List all bookmarks
      const bookmarkRecords = await listAllRecords(
        oauthSession,
        BOOKMARK_COLLECTION,
      );
      const count = bookmarkRecords.filter((record: any) =>
        record.value.tags?.includes(tagValue)
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

      // Get the tag
      const getParams = new URLSearchParams({
        repo: oauthSession.did,
        collection: TAG_COLLECTION,
        rkey,
      });
      const getResponse = await oauthSession.makeRequest(
        "GET",
        `${oauthSession.pdsUrl}/xrpc/com.atproto.repo.getRecord?${getParams}`,
      );

      if (!getResponse.ok) {
        const errorText = await getResponse.text();
        throw new Error(`Failed to get tag: ${errorText}`);
      }

      const tagData = await getResponse.json();
      const tagValue = tagData.value.value;

      // Remove tag from all bookmarks
      const bookmarkRecords = await listAllRecords(
        oauthSession,
        BOOKMARK_COLLECTION,
      );

      await Promise.all(
        bookmarkRecords
          .filter((record: any) => record.value.tags?.includes(tagValue))
          .map(async (record: any) => {
            const bookmarkRkey = record.uri.split("/").pop();
            const updatedTags = record.value.tags.filter((t: string) =>
              t !== tagValue
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

  return app;
}
