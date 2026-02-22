/**
 * Initial data API route.
 * Fetches bookmarks, tags, annotations, and settings in a single request
 * to avoid token refresh race conditions.
 */

import type { App } from "@fresh/core";
import {
  ANNOTATION_COLLECTION,
  BOOKMARK_COLLECTION,
  createAuthErrorResponse,
  getSessionFromRequest,
  setSessionCookie,
  TAG_COLLECTION,
} from "../../lib/route-utils.ts";
import { getUserSettings } from "../../lib/settings.ts";
import { migrateAnnotations } from "../../lib/migration-annotations.ts";
import { repairMissingFavicons } from "../../lib/repair-favicons.ts";
import type {
  AnnotationRecord,
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

      const annotationsParams = new URLSearchParams({
        repo: oauthSession.did,
        collection: ANNOTATION_COLLECTION,
        limit: "100",
      });

      const [bookmarksResponse, tagsResponse, annotationsResponse, settings] =
        await Promise.all([
          oauthSession.makeRequest(
            "GET",
            `${oauthSession.pdsUrl}/xrpc/com.atproto.repo.listRecords?${bookmarksParams}`,
          ),
          oauthSession.makeRequest(
            "GET",
            `${oauthSession.pdsUrl}/xrpc/com.atproto.repo.listRecords?${tagsParams}`,
          ),
          oauthSession.makeRequest(
            "GET",
            `${oauthSession.pdsUrl}/xrpc/com.atproto.repo.listRecords?${annotationsParams}`,
          ),
          getUserSettings(oauthSession.did),
        ]);

      // Build annotation lookup map (rkey → annotation)
      const annotationMap = new Map<string, AnnotationRecord>();
      let annotationsOk = false;
      if (annotationsResponse.ok) {
        annotationsOk = true;
        const annotationsData = await annotationsResponse.json();
        for (const record of annotationsData.records || []) {
          const rkey = record.uri.split("/").pop();
          if (rkey) {
            annotationMap.set(rkey, record.value as AnnotationRecord);
          }
        }
      }

      let bookmarks: EnrichedBookmark[] = [];
      let bookmarkRecords: any[] = [];
      if (bookmarksResponse.ok) {
        const bookmarksData = await bookmarksResponse.json();
        bookmarkRecords = bookmarksData.records || [];
        bookmarks = bookmarkRecords.map((record: any) => {
          const rkey = record.uri.split("/").pop();
          const annotation = rkey ? annotationMap.get(rkey) : undefined;
          return {
            uri: record.uri,
            cid: record.cid,
            subject: record.value.subject,
            createdAt: record.value.createdAt,
            tags: record.value.tags || [],
            title: annotation?.title || record.value.$enriched?.title ||
              record.value.title,
            description: annotation?.description ||
              record.value.$enriched?.description,
            favicon: annotation?.favicon || record.value.$enriched?.favicon,
            image: annotation?.image || record.value.$enriched?.image,
            note: annotation?.note,
          };
        });
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

      const result: InitialDataResponse = { bookmarks, tags, settings };
      const response = setSessionCookie(
        Response.json(result),
        setCookieHeader,
      );

      // Background tasks (fire-and-forget, run after response is sent)
      // See BACKGROUND-TASKS.md for details on when these can be removed.
      if (annotationsOk && bookmarkRecords.length > 0) {
        migrateAnnotations(oauthSession, bookmarkRecords, annotationMap)
          .catch((err) =>
            console.error("Background annotation migration error:", err)
          );
        repairMissingFavicons(oauthSession, bookmarkRecords, annotationMap)
          .catch((err) =>
            console.error("Background favicon repair error:", err)
          );
      }

      return response;
    } catch (error: any) {
      console.error("Error fetching initial data:", error);
      return Response.json({ error: error.message }, { status: 500 });
    }
  });

  return app;
}
