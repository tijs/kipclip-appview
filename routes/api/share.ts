/**
 * Share API routes.
 * Public endpoint for fetching shared bookmarks by DID and tags.
 */

import type { App } from "@fresh/core";
import { resolveDid } from "../../lib/plc-resolver.ts";
import {
  ANNOTATION_COLLECTION,
  BOOKMARK_COLLECTION,
} from "../../lib/route-utils.ts";
import { decodeTagsFromUrl } from "../../shared/utils.ts";
import type {
  AnnotationRecord,
  EnrichedBookmark,
  SharedBookmarksResponse,
} from "../../shared/types.ts";

export function registerShareApiRoutes(app: App<any>): App<any> {
  app = app.get("/api/share/:did/:encodedTags", async (ctx) => {
    try {
      const did = ctx.params.did;
      const encodedTags = ctx.params.encodedTags;

      let tags: string[];
      try {
        tags = decodeTagsFromUrl(encodedTags);
      } catch (err: any) {
        return Response.json(
          { error: `Invalid tag encoding: ${err.message}` },
          { status: 400 },
        );
      }

      if (!did.startsWith("did:")) {
        return Response.json({ error: "Invalid DID format" }, { status: 400 });
      }

      // Use cached PLC resolver
      const resolved = await resolveDid(did);
      if (!resolved) {
        return Response.json({ error: "User not found" }, { status: 404 });
      }

      const { pdsUrl, handle } = resolved;

      const bookmarkParams = new URLSearchParams({
        repo: did,
        collection: BOOKMARK_COLLECTION,
        limit: "100",
      });

      const annotationParams = new URLSearchParams({
        repo: did,
        collection: ANNOTATION_COLLECTION,
        limit: "100",
      });

      // Fetch bookmarks and annotations in parallel (both are public)
      const [bookmarksResponse, annotationsResponse] = await Promise.all([
        fetch(
          `${pdsUrl}/xrpc/com.atproto.repo.listRecords?${bookmarkParams}`,
        ),
        fetch(
          `${pdsUrl}/xrpc/com.atproto.repo.listRecords?${annotationParams}`,
        ).catch(() => null),
      ]);

      if (!bookmarksResponse.ok) {
        const errorText = await bookmarksResponse.text();
        if (
          bookmarksResponse.status === 400 || errorText.includes("not found")
        ) {
          const result: SharedBookmarksResponse = {
            bookmarks: [],
            handle,
            tags,
          };
          return Response.json(result);
        }
        throw new Error(`Failed to fetch bookmarks: ${errorText}`);
      }

      // Build annotation lookup map
      const annotationMap = new Map<string, AnnotationRecord>();
      if (annotationsResponse?.ok) {
        const annotationsData = await annotationsResponse.json();
        for (const record of annotationsData.records || []) {
          const rkey = record.uri.split("/").pop();
          if (rkey) {
            annotationMap.set(rkey, record.value as AnnotationRecord);
          }
        }
      }

      const data = await bookmarksResponse.json();
      const allBookmarks: EnrichedBookmark[] = data.records.map((
        record: any,
      ) => {
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

      const filteredBookmarks = allBookmarks.filter((bookmark) =>
        tags.every((tag) => bookmark.tags?.includes(tag))
      );

      const result: SharedBookmarksResponse = {
        bookmarks: filteredBookmarks,
        handle,
        tags,
      };

      return Response.json(result);
    } catch (error: any) {
      console.error("Error fetching shared bookmarks:", error);
      return Response.json({ error: error.message }, { status: 500 });
    }
  });

  return app;
}
