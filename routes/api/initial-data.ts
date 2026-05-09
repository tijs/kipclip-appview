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
  type RateLimitInfo,
  setSessionCookie,
  TAG_COLLECTION,
} from "../../lib/route-utils.ts";
import { getUserPreferences } from "../../lib/preferences.ts";
import { getUserSettings } from "../../lib/settings.ts";
import { runPdsMigrations } from "../../lib/pds-migrations.ts";
import { isUserSupporter } from "../../lib/atprotofans.ts";
import { shouldReadFromMirror } from "../../lib/mirror-config.ts";
import {
  firstPageBookmarks,
  getMirrorInitialExtras,
  nextPageBookmarks,
} from "../../mirror/queries.ts";
import { decrypt } from "../../lib/encryption.ts";
import { captureMessage } from "../../lib/sentry.ts";
import { createTimer } from "../../lib/server-timing.ts";
import type {
  AnnotationRecord,
  EnrichedBookmark,
  EnrichedTag,
  InitialDataResponse,
  UserPreferences,
  UserSettings,
} from "../../shared/types.ts";
import { newestTidCursor } from "../../lib/tid.ts";
import { autoEnrollIfNeeded } from "../../lib/auto-enroll.ts";

/** Pick the lower rate limit remaining from two PDS responses. */
function pickLowestRateLimit(
  a?: RateLimitInfo,
  b?: RateLimitInfo,
): RateLimitInfo | undefined {
  if (a && b) return a.remaining < b.remaining ? a : b;
  return a || b;
}

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
const migratedUsers = new Set<string>();

export function registerInitialDataRoutes(app: App<any>): App<any> {
  // Paginated initial data: first call returns tags + settings + first page;
  // subsequent calls (with cursors) return additional bookmark pages.
  app = app.get("/api/initial-data", async (ctx) => {
    const timer = createTimer();
    try {
      const { session: oauthSession, setCookieHeader, error } = await timer
        .span("session", () => getSessionFromRequest(ctx.req));

      if (!oauthSession) {
        return createAuthErrorResponse(error);
      }

      const url = new URL(ctx.req.url);
      const bookmarkCursor = url.searchParams.get("bookmarkCursor") ||
        undefined;
      const annotationCursor = url.searchParams.get("annotationCursor") ||
        undefined;
      const isFirstPage = !bookmarkCursor;

      const mirrorDecision = await timer.span(
        "mirror-decision",
        () => shouldReadFromMirror(oauthSession.did),
      );
      if (isFirstPage && !mirrorDecision.fromMirror) {
        autoEnrollIfNeeded(
          oauthSession.did,
          oauthSession.pdsUrl ?? "",
        );
      }
      if (mirrorDecision.fromMirror) {
        // Wrap the mirror branch so a Turso connection flake (eu-west-1
        // ↔ Deno Deploy US sometimes drops requests) falls through to
        // the PDS path below instead of 500-ing the user. Sentry warning
        // surfaces the degradation event in production.
        try {
          if (isFirstPage) {
            const parallelStart = performance.now();
            const [page, extras, isSupporter] = await Promise.all([
              timer.span(
                "mirror-bookmarks",
                () => firstPageBookmarks(oauthSession.did),
              ),
              timer.span(
                "mirror-extras",
                () => getMirrorInitialExtras(oauthSession.did),
              ),
              timer.span(
                "supporter",
                () => isUserSupporter(oauthSession),
              ),
            ]);
            timer.add("first-page-parallel", performance.now() - parallelStart);
            // Safeguard: a backfill-complete mirror with 0 bookmarks is
            // suspicious. Fall through so PDS confirms rather than returning
            // an empty library that may be a data integrity problem.
            if (page.bookmarks.length === 0 && !page.cursor) {
              captureMessage(
                "mirror empty safeguard: falling through to PDS",
                "warning",
                { did: oauthSession.did, op: "GET /api/initial-data" },
              );
              throw new Error("mirror_empty_fallthrough");
            }
            const settings: UserSettings = {
              instapaperEnabled: extras.instapaperEnabled,
              instapaperUsername: extras.instapaperEnabled &&
                  extras.instapaperUsernameEncrypted
                ? await decrypt(extras.instapaperUsernameEncrypted).catch(() =>
                  undefined
                )
                : undefined,
            };
            const preferences: UserPreferences = {
              dateFormat: extras.preferences?.dateFormat || "us",
              readingListTag: extras.preferences?.readingListTag || "toread",
            };
            const result: InitialDataResponse = {
              bookmarks: page.bookmarks,
              settings,
              preferences,
              bookmarkCursor: page.cursor,
              isSupporter,
              ...(mirrorDecision.syncing ? { syncing: true } : {}),
            };
            return timer.finalize(
              setSessionCookie(Response.json(result), setCookieHeader),
            );
          }
          const page = await timer.span(
            "mirror-next-page",
            () => nextPageBookmarks(oauthSession.did, bookmarkCursor),
          );
          return timer.finalize(
            setSessionCookie(
              Response.json({
                bookmarks: page.bookmarks,
                bookmarkCursor: page.cursor,
                ...(mirrorDecision.syncing ? { syncing: true } : {}),
              }),
              setCookieHeader,
            ),
          );
        } catch (mirrorErr) {
          captureMessage(
            "mirror read fallback to PDS",
            "warning",
            {
              did: oauthSession.did,
              op: isFirstPage
                ? "initial-data first-page"
                : "initial-data next-page",
              error: String(mirrorErr),
            },
          );
          // Fall through to the PDS path below.
        }
      }

      if (isFirstPage) {
        // First page: fetch tags + settings + first page bookmarks/annotations.
        // newestFirst uses a future TID cursor so newest bookmarks appear on
        // page 1 even when old hex rkeys would otherwise dominate the sort.
        const newestFirst = url.searchParams.get("newestFirst") === "true";
        const firstPageOpts = newestFirst
          ? { cursor: newestTidCursor() }
          : { reverse: true };

        const [
          bookmarkPage,
          annotationPage,
          settings,
          preferences,
          isSupporter,
        ] = await Promise.all([
          timer.span(
            "pds-bookmarks",
            () => listOnePage(oauthSession, BOOKMARK_COLLECTION, firstPageOpts),
          ),
          timer.span(
            "pds-annotations",
            () =>
              listOnePage(oauthSession, ANNOTATION_COLLECTION, firstPageOpts),
          ),
          timer.span(
            "pds-settings",
            () => getUserSettings(oauthSession.did),
          ),
          timer.span(
            "pds-preferences",
            () => getUserPreferences(oauthSession),
          ),
          timer.span(
            "supporter",
            () => isUserSupporter(oauthSession),
          ),
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

        const rateLimit = pickLowestRateLimit(
          bookmarkPage.rateLimit,
          annotationPage.rateLimit,
        );

        const result: InitialDataResponse = {
          bookmarks,
          settings,
          preferences,
          bookmarkCursor: bookmarkPage.cursor,
          annotationCursor: annotationPage.cursor,
          rateLimit,
          isSupporter,
        };

        const response = timer.finalize(
          setSessionCookie(Response.json(result), setCookieHeader),
        );

        // Background migrations: run once per user per server session.
        // Tags are fetched inside this branch because runPdsMigrations needs
        // them for tag-record migrations.
        const userDid = oauthSession.did;
        if (bookmarkPage.records.length > 0 && !migratedUsers.has(userDid)) {
          migratedUsers.add(userDid);
          Promise.all([
            listAllRecords(oauthSession, BOOKMARK_COLLECTION),
            listAllRecords(oauthSession, ANNOTATION_COLLECTION),
            listAllRecords(oauthSession, TAG_COLLECTION),
          ]).then(([allBookmarks, allAnnotations, allTagRecords]) => {
            const allAnnotationMap = new Map<string, AnnotationRecord>();
            for (const record of allAnnotations) {
              const rkey = record.uri.split("/").pop();
              if (rkey) {
                allAnnotationMap.set(rkey, record.value as AnnotationRecord);
              }
            }
            const tagRecords: EnrichedTag[] = allTagRecords.map(
              (record: any) => ({
                uri: record.uri,
                cid: record.cid,
                value: record.value.value,
                createdAt: record.value.createdAt,
              }),
            );
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
        timer.span(
          "pds-bookmarks",
          () =>
            listOnePage(oauthSession, BOOKMARK_COLLECTION, {
              cursor: bookmarkCursor,
              reverse: true,
            }),
        ),
        annotationCursor
          ? timer.span(
            "pds-annotations",
            () =>
              listOnePage(oauthSession, ANNOTATION_COLLECTION, {
                cursor: annotationCursor,
                reverse: true,
              }),
          )
          : Promise.resolve(
            { records: [] as any[], cursor: undefined, rateLimit: undefined },
          ),
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

      const rateLimit = pickLowestRateLimit(
        bookmarkPage.rateLimit,
        annotationPage.rateLimit,
      );

      const response = timer.finalize(
        setSessionCookie(
          Response.json({
            bookmarks,
            bookmarkCursor: bookmarkPage.cursor,
            annotationCursor: annotationPage.cursor,
            rateLimit,
          }),
          setCookieHeader,
        ),
      );
      return response;
    } catch (error: any) {
      console.error("Error fetching initial data:", error);
      return Response.json({ error: error.message }, { status: 500 });
    }
  });

  return app;
}
