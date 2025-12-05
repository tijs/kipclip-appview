/**
 * Share API routes.
 * Public endpoint for fetching shared bookmarks by DID and tags.
 */

import type { App } from "@fresh/core";
import { resolveDid } from "../../lib/plc-resolver.ts";
import { BOOKMARK_COLLECTION } from "../../lib/route-utils.ts";
import { decodeTagsFromUrl } from "../../shared/utils.ts";
import type {
  EnrichedBookmark,
  SharedBookmarksResponse,
} from "../../shared/types.ts";

export function registerShareApiRoutes(app: App<any>): App<any> {
  // Debug endpoint to test PLC resolution
  app = app.get("/api/debug/plc/:did", async (ctx) => {
    const did = ctx.params.did;
    console.log(`[Debug] Testing PLC resolution for ${did}`);

    try {
      // Test raw fetch first
      const plcUrl = `https://plc.directory/${did}`;
      console.log(`[Debug] Fetching ${plcUrl}`);
      const rawResponse = await fetch(plcUrl);
      console.log(`[Debug] Raw fetch status: ${rawResponse.status}`);

      if (!rawResponse.ok) {
        return Response.json({
          did,
          rawFetchStatus: rawResponse.status,
          rawFetchOk: false,
        });
      }

      const rawDoc = await rawResponse.json();
      console.log(`[Debug] Raw doc received, has service: ${!!rawDoc.service}`);

      // Parse it ourselves to test
      const pdsService = rawDoc.service?.find(
        (s: { id: string }) => s.id === "#atproto_pds",
      );
      let handle = did;
      if (rawDoc.alsoKnownAs?.length > 0) {
        const atUri = rawDoc.alsoKnownAs.find((aka: string) =>
          aka.startsWith("at://")
        );
        if (atUri) {
          handle = atUri.replace("at://", "");
        }
      }
      const manualResolved = pdsService?.serviceEndpoint
        ? { did, pdsUrl: pdsService.serviceEndpoint, handle }
        : null;

      // Now test through resolver
      let resolved = null;
      let resolverError = null;
      try {
        resolved = await resolveDid(did);
      } catch (e: any) {
        resolverError = e.message;
      }
      console.log(`[Debug] Resolved result: ${JSON.stringify(resolved)}`);

      return Response.json({
        did,
        rawFetchOk: true,
        rawDoc,
        manualResolved,
        resolved,
        resolverError,
      });
    } catch (error: any) {
      console.error(`[Debug] Error:`, error);
      return Response.json({
        did,
        error: error.message,
        stack: error.stack,
      }, { status: 500 });
    }
  });

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
