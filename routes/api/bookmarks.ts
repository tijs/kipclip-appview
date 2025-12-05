/**
 * Bookmark API routes.
 * Handles CRUD operations for user bookmarks stored on their PDS.
 */

import type { App } from "@fresh/core";
import { extractUrlMetadata } from "../../lib/enrichment.ts";
import {
  BOOKMARK_COLLECTION,
  createAuthErrorResponse,
  getSessionFromRequest,
  setSessionCookie,
} from "../../lib/route-utils.ts";
import type {
  AddBookmarkRequest,
  AddBookmarkResponse,
  EnrichedBookmark,
  ListBookmarksResponse,
  UpdateBookmarkTagsRequest,
  UpdateBookmarkTagsResponse,
} from "../../shared/types.ts";

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
      const response = await oauthSession.makeRequest(
        "GET",
        `${oauthSession.pdsUrl}/xrpc/com.atproto.repo.listRecords?${params}`,
      );

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Failed to list records: ${errorText}`);
      }

      const data = await response.json();
      const bookmarks: EnrichedBookmark[] = data.records.map((record: any) => ({
        uri: record.uri,
        cid: record.cid,
        subject: record.value.subject,
        createdAt: record.value.createdAt,
        tags: record.value.tags || [],
        title: record.value.$enriched?.title || record.value.title,
        description: record.value.$enriched?.description,
        favicon: record.value.$enriched?.favicon,
      }));

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

      let url: URL;
      try {
        url = new URL(body.url);
        if (!url.protocol.startsWith("http")) {
          return Response.json(
            { error: "Only HTTP(S) URLs are supported" },
            { status: 400 },
          );
        }
      } catch {
        return Response.json({ error: "Invalid URL format" }, { status: 400 });
      }

      const metadata = await extractUrlMetadata(body.url);

      const record = {
        subject: body.url,
        createdAt: new Date().toISOString(),
        tags: [],
        $enriched: {
          title: metadata.title,
          description: metadata.description,
          favicon: metadata.favicon,
        },
      };

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
      const bookmark: EnrichedBookmark = {
        uri: data.uri,
        cid: data.cid,
        subject: body.url,
        createdAt: record.createdAt,
        tags: [],
        title: metadata.title,
        description: metadata.description,
        favicon: metadata.favicon,
      };

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
      const record = {
        ...currentRecord.value,
        subject: body.url || currentRecord.value.subject,
        tags: body.tags,
        $enriched: {
          ...currentRecord.value.$enriched,
          title: body.title !== undefined
            ? body.title
            : currentRecord.value.$enriched?.title,
          description: body.description !== undefined
            ? body.description
            : currentRecord.value.$enriched?.description,
        },
      };

      const response = await oauthSession.makeRequest(
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

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Failed to update record: ${errorText}`);
      }

      const data = await response.json();
      const bookmark: EnrichedBookmark = {
        uri: data.uri,
        cid: data.cid,
        subject: record.subject,
        createdAt: record.createdAt,
        tags: record.tags,
        title: record.$enriched?.title,
        description: record.$enriched?.description,
        favicon: record.$enriched?.favicon,
      };

      const result: UpdateBookmarkTagsResponse = { success: true, bookmark };
      return setSessionCookie(Response.json(result), setCookieHeader);
    } catch (error: any) {
      console.error("Error updating bookmark tags:", error);
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
