/**
 * Share API routes.
 * Public endpoint for fetching shared bookmarks by DID and tags.
 */

import type { App } from "@fresh/core";
import { BOOKMARK_COLLECTION } from "../../lib/route-utils.ts";
import { decodeTagsFromUrl } from "../../shared/utils.ts";
import type {
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

      const didDocResponse = await fetch(`https://plc.directory/${did}`);
      if (!didDocResponse.ok) {
        return Response.json({ error: "User not found" }, { status: 404 });
      }

      const didDoc = await didDocResponse.json();
      const pdsService = didDoc.service?.find((s: any) =>
        s.id === "#atproto_pds"
      );
      if (!pdsService?.serviceEndpoint) {
        return Response.json({ error: "User's PDS not found" }, {
          status: 404,
        });
      }

      const pdsUrl = pdsService.serviceEndpoint;
      let handle = did;
      if (didDoc.alsoKnownAs && didDoc.alsoKnownAs.length > 0) {
        const atUri = didDoc.alsoKnownAs.find((aka: string) =>
          aka.startsWith("at://")
        );
        if (atUri) {
          handle = atUri.replace("at://", "");
        }
      }

      const params = new URLSearchParams({
        repo: did,
        collection: BOOKMARK_COLLECTION,
        limit: "100",
      });

      const response = await fetch(
        `${pdsUrl}/xrpc/com.atproto.repo.listRecords?${params}`,
      );

      if (!response.ok) {
        const errorText = await response.text();
        if (response.status === 400 || errorText.includes("not found")) {
          const result: SharedBookmarksResponse = {
            bookmarks: [],
            handle,
            tags,
          };
          return Response.json(result);
        }
        throw new Error(`Failed to fetch bookmarks: ${errorText}`);
      }

      const data = await response.json();
      const allBookmarks: EnrichedBookmark[] = data.records.map((
        record: any,
      ) => ({
        uri: record.uri,
        cid: record.cid,
        subject: record.value.subject,
        createdAt: record.value.createdAt,
        tags: record.value.tags || [],
        title: record.value.$enriched?.title || record.value.title,
        description: record.value.$enriched?.description,
        favicon: record.value.$enriched?.favicon,
      }));

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
