/**
 * Initial data API route.
 * Fetches bookmarks and tags in a single request to avoid token refresh race conditions.
 */

import type { App } from "@fresh/core";
import {
  BOOKMARK_COLLECTION,
  createAuthErrorResponse,
  getSessionFromRequest,
  setSessionCookie,
  TAG_COLLECTION,
} from "../../lib/route-utils.ts";
import type {
  EnrichedBookmark,
  EnrichedTag,
  InitialDataResponse,
} from "../../shared/types.ts";

export function registerInitialDataRoutes(app: App<any>): App<any> {
  app = app.get("/api/initial-data", async (ctx) => {
    try {
      const { session: oauthSession, setCookieHeader, error } =
        await getSessionFromRequest(ctx.req);

      if (!oauthSession) {
        return createAuthErrorResponse(error);
      }

      const bookmarksParams = new URLSearchParams({
        repo: oauthSession.did,
        collection: BOOKMARK_COLLECTION,
        limit: "100",
      });

      const tagsParams = new URLSearchParams({
        repo: oauthSession.did,
        collection: TAG_COLLECTION,
        limit: "100",
      });

      const [bookmarksResponse, tagsResponse] = await Promise.all([
        oauthSession.makeRequest(
          "GET",
          `${oauthSession.pdsUrl}/xrpc/com.atproto.repo.listRecords?${bookmarksParams}`,
        ),
        oauthSession.makeRequest(
          "GET",
          `${oauthSession.pdsUrl}/xrpc/com.atproto.repo.listRecords?${tagsParams}`,
        ),
      ]);

      let bookmarks: EnrichedBookmark[] = [];
      if (bookmarksResponse.ok) {
        const bookmarksData = await bookmarksResponse.json();
        bookmarks = bookmarksData.records.map((record: any) => ({
          uri: record.uri,
          cid: record.cid,
          subject: record.value.subject,
          createdAt: record.value.createdAt,
          tags: record.value.tags || [],
          title: record.value.$enriched?.title || record.value.title,
          description: record.value.$enriched?.description,
          favicon: record.value.$enriched?.favicon,
        }));
      }

      let tags: EnrichedTag[] = [];
      if (tagsResponse.ok) {
        const tagsData = await tagsResponse.json();
        tags = tagsData.records.map((record: any) => ({
          uri: record.uri,
          cid: record.cid,
          value: record.value.value,
          createdAt: record.value.createdAt,
        }));
      }

      const result: InitialDataResponse = { bookmarks, tags };
      return setSessionCookie(Response.json(result), setCookieHeader);
    } catch (error: any) {
      console.error("Error fetching initial data:", error);
      return Response.json({ error: error.message }, { status: 500 });
    }
  });

  return app;
}
