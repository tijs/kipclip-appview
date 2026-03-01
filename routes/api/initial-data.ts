/**
 * Initial data API routes.
 * Supports progressive loading: first page returns quickly (~1s),
 * subsequent pages fetched in background by the client.
 */

import type { App } from "@fresh/core";
import {
  ANNOTATION_COLLECTION,
  BOOKMARK_COLLECTION,
  createAuthErrorResponse,
  getSessionFromRequest,
  listAllRecords,
  listOnePage,
  setSessionCookie,
  TAG_COLLECTION,
} from "../../lib/route-utils.ts";
import { getUserPreferences } from "../../lib/preferences.ts";
import { getUserSettings } from "../../lib/settings.ts";
import { runPdsMigrations } from "../../lib/pds-migrations.ts";
import type {
  AnnotationRecord,
  EnrichedBookmark,
  EnrichedTag,
  InitialDataResponse,
} from "../../shared/types.ts";

/** Join bookmark records with an annotation map to produce EnrichedBookmarks. */
function joinBookmarksWithAnnotations(
  bookmarkRecords: any[],
  annotationMap: Map<string, AnnotationRecord>,
): EnrichedBookmark[] {
  return bookmarkRecords.map((record: any) => {
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

// Track which users have already run migrations this server session.
// Migrations are one-time data fixes; no need to re-run on every page load.
const migratedUsers = new Set<string>();

export function registerInitialDataRoutes(app: App<any>): App<any> {
  // Paginated initial data: first call returns tags + settings + first page;
  // subsequent calls (with cursors) return additional bookmark pages.
  app = app.get("/api/initial-data", async (ctx) => {
    try {
      const { session: oauthSession, setCookieHeader, error } =
        await getSessionFromRequest(ctx.req);

      if (!oauthSession) {
        return createAuthErrorResponse(error);
      }

      const url = new URL(ctx.req.url);
      const bookmarkCursor = url.searchParams.get("bookmarkCursor") ||
        undefined;
      const annotationCursor = url.searchParams.get("annotationCursor") ||
        undefined;
      const isFirstPage = !bookmarkCursor;

      if (isFirstPage) {
        // First page: fetch tags + settings + first page bookmarks/annotations
        // All in parallel (~5 PDS requests, ~1s)
        const [
          bookmarkPage,
          annotationPage,
          tagRecords,
          settings,
          preferences,
        ] = await Promise.all([
          listOnePage(oauthSession, BOOKMARK_COLLECTION, { reverse: true }),
          listOnePage(oauthSession, ANNOTATION_COLLECTION, { reverse: true }),
          listAllRecords(oauthSession, TAG_COLLECTION),
          getUserSettings(oauthSession.did),
          getUserPreferences(oauthSession),
        ]);

        const annotationMap = new Map<string, AnnotationRecord>();
        for (const record of annotationPage.records) {
          const rkey = record.uri.split("/").pop();
          if (rkey) annotationMap.set(rkey, record.value as AnnotationRecord);
        }

        const bookmarks = joinBookmarksWithAnnotations(
          bookmarkPage.records,
          annotationMap,
        );

        const tags: EnrichedTag[] = tagRecords.map((record: any) => ({
          uri: record.uri,
          cid: record.cid,
          value: record.value.value,
          createdAt: record.value.createdAt,
        }));

        const result: InitialDataResponse = {
          bookmarks,
          tags,
          settings,
          preferences,
          bookmarkCursor: bookmarkPage.cursor,
          annotationCursor: annotationPage.cursor,
        };

        const response = setSessionCookie(
          Response.json(result),
          setCookieHeader,
        );

        // Background migrations: run once per user per server session
        const userDid = oauthSession.did;
        if (bookmarkPage.records.length > 0 && !migratedUsers.has(userDid)) {
          migratedUsers.add(userDid);
          Promise.all([
            listAllRecords(oauthSession, BOOKMARK_COLLECTION),
            listAllRecords(oauthSession, ANNOTATION_COLLECTION),
          ]).then(([allBookmarks, allAnnotations]) => {
            const allAnnotationMap = new Map<string, AnnotationRecord>();
            for (const record of allAnnotations) {
              const rkey = record.uri.split("/").pop();
              if (rkey) {
                allAnnotationMap.set(rkey, record.value as AnnotationRecord);
              }
            }
            return runPdsMigrations({
              oauthSession,
              bookmarkRecords: allBookmarks,
              tagRecords,
              annotationMap: allAnnotationMap,
            });
          }).catch((err) =>
            console.error("Background PDS migration error:", err)
          );
        }

        return response;
      }

      // Subsequent page: fetch next page of bookmarks + annotations
      const [bookmarkPage, annotationPage] = await Promise.all([
        listOnePage(oauthSession, BOOKMARK_COLLECTION, {
          cursor: bookmarkCursor,
          reverse: true,
        }),
        annotationCursor
          ? listOnePage(oauthSession, ANNOTATION_COLLECTION, {
            cursor: annotationCursor,
            reverse: true,
          })
          : Promise.resolve({ records: [] as any[], cursor: undefined }),
      ]);

      const annotationMap = new Map<string, AnnotationRecord>();
      for (const record of annotationPage.records) {
        const rkey = record.uri.split("/").pop();
        if (rkey) annotationMap.set(rkey, record.value as AnnotationRecord);
      }

      const bookmarks = joinBookmarksWithAnnotations(
        bookmarkPage.records,
        annotationMap,
      );

      const response = setSessionCookie(
        Response.json({
          bookmarks,
          bookmarkCursor: bookmarkPage.cursor,
          annotationCursor: annotationPage.cursor,
        }),
        setCookieHeader,
      );
      return response;
    } catch (error: any) {
      console.error("Error fetching initial data:", error);
      return Response.json({ error: error.message }, { status: 500 });
    }
  });

  // Lightweight sync-check: hash first page of CIDs to detect changes
  app = app.get("/api/sync-check", async (ctx) => {
    try {
      const { session: oauthSession, setCookieHeader, error } =
        await getSessionFromRequest(ctx.req);

      if (!oauthSession) {
        return createAuthErrorResponse(error);
      }

      const [bookmarkPage, tagPage] = await Promise.all([
        listOnePage(oauthSession, BOOKMARK_COLLECTION),
        listOnePage(oauthSession, TAG_COLLECTION),
      ]);

      const hashInput = [
        ...bookmarkPage.records.map((r: any) => r.cid),
        bookmarkPage.cursor || "",
        ...tagPage.records.map((r: any) => r.cid),
        tagPage.cursor || "",
      ].join("|");

      const hashBuffer = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(hashInput),
      );
      const hashArray = new Uint8Array(hashBuffer);
      const hash = Array.from(hashArray, (b) => b.toString(16).padStart(2, "0"))
        .join("").slice(0, 16);

      const response = setSessionCookie(
        Response.json({ hash }),
        setCookieHeader,
      );
      return response;
    } catch (error: any) {
      console.error("Error in sync-check:", error);
      return Response.json({ error: error.message }, { status: 500 });
    }
  });

  return app;
}
