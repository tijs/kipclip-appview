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
  listAllRecords,
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

export function registerInitialDataRoutes(app: App<any>): App<any> {
  app = app.get("/api/initial-data", async (ctx) => {
    try {
      const { session: oauthSession, setCookieHeader, error } =
        await getSessionFromRequest(ctx.req);

      if (!oauthSession) {
        return createAuthErrorResponse(error);
      }

      const [
        bookmarkRecords,
        tagRecords,
        annotationRecords,
        settings,
        preferences,
      ] = await Promise.all([
        listAllRecords(oauthSession, BOOKMARK_COLLECTION),
        listAllRecords(oauthSession, TAG_COLLECTION),
        listAllRecords(oauthSession, ANNOTATION_COLLECTION),
        getUserSettings(oauthSession.did),
        getUserPreferences(oauthSession),
      ]);

      // Build annotation lookup map (rkey → annotation)
      const annotationMap = new Map<string, AnnotationRecord>();
      const annotationsOk = true;
      for (const record of annotationRecords) {
        const rkey = record.uri.split("/").pop();
        if (rkey) {
          annotationMap.set(rkey, record.value as AnnotationRecord);
        }
      }

      const bookmarks: EnrichedBookmark[] = bookmarkRecords.map(
        (record: any) => {
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
        },
      ).sort((a, b) => b.createdAt.localeCompare(a.createdAt));

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
      };
      const response = setSessionCookie(
        Response.json(result),
        setCookieHeader,
      );

      // Background migrations (fire-and-forget, run after response is sent)
      // See BACKGROUND-TASKS.md for details on when these can be removed.
      if (annotationsOk && bookmarkRecords.length > 0) {
        runPdsMigrations({
          oauthSession,
          bookmarkRecords,
          tagRecords,
          annotationMap,
        }).catch((err) =>
          console.error("Background PDS migration error:", err)
        );
      }

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

      // Fetch first page of each collection (3 requests instead of 30+)
      const fetchFirstPage = async (collection: string) => {
        const params = new URLSearchParams({
          repo: oauthSession.did,
          collection,
          limit: "100",
        });
        const res = await oauthSession.makeRequest(
          "GET",
          `${oauthSession.pdsUrl}/xrpc/com.atproto.repo.listRecords?${params}`,
        );
        if (!res.ok) return { cids: [] as string[], cursor: "" };
        const data = await res.json();
        const cids = (data.records || []).map((r: any) => r.cid);
        return { cids, cursor: data.cursor || "" };
      };

      const [bookmarkPage, tagPage] = await Promise.all([
        fetchFirstPage(BOOKMARK_COLLECTION),
        fetchFirstPage(TAG_COLLECTION),
      ]);

      // Build hash from CIDs + cursors
      const hashInput = [
        ...bookmarkPage.cids,
        bookmarkPage.cursor,
        ...tagPage.cids,
        tagPage.cursor,
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
