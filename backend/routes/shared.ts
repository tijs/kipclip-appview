import type { App } from "jsr:@fresh/core@^2.2.0";

// Fresh App with any state type (we don't use Fresh's state management)
type FreshApp = App<any>;
import type {
  EnrichedBookmark,
  SharedBookmarksResponse,
} from "../../shared/types.ts";
import { decodeTagsFromUrl } from "../../shared/utils.ts";

const BOOKMARK_COLLECTION = "community.lexicon.bookmarks.bookmark";

/**
 * Register shared bookmark routes on the Fresh app
 */
export function registerSharedRoutes(app: FreshApp): FreshApp {
  /**
   * Public endpoint to get shared bookmarks filtered by tags
   * No authentication required - bookmarks are public AT Protocol records
   */
  app = app.get("/api/share/:did/:encodedTags", async (ctx) => {
    try {
      const did = ctx.params.did;
      const encodedTags = ctx.params.encodedTags;

      // Decode tags from URL
      let tags: string[];
      try {
        tags = decodeTagsFromUrl(encodedTags);
      } catch (err: any) {
        return Response.json(
          { error: `Invalid tag encoding: ${err.message}` },
          { status: 400 },
        );
      }

      // Validate DID format
      if (!did.startsWith("did:")) {
        return Response.json({ error: "Invalid DID format" }, { status: 400 });
      }

      // Resolve DID to get PDS URL and handle
      // We need to resolve the DID document to find the PDS service endpoint
      const didDocResponse = await fetch(
        `https://plc.directory/${did}`,
      );

      if (!didDocResponse.ok) {
        return Response.json({ error: "User not found" }, { status: 404 });
      }

      const didDoc = await didDocResponse.json();

      // Extract PDS URL from service endpoints
      const pdsService = didDoc.service?.find(
        (s: any) => s.id === "#atproto_pds",
      );
      if (!pdsService?.serviceEndpoint) {
        return Response.json({ error: "User's PDS not found" }, {
          status: 404,
        });
      }

      const pdsUrl = pdsService.serviceEndpoint;

      // Get handle from DID document alsoKnownAs
      let handle = did;
      if (didDoc.alsoKnownAs && didDoc.alsoKnownAs.length > 0) {
        // alsoKnownAs contains entries like "at://handle"
        const atUri = didDoc.alsoKnownAs.find((aka: string) =>
          aka.startsWith("at://")
        );
        if (atUri) {
          handle = atUri.replace("at://", "");
        }
      }

      // Fetch public bookmark records from the user's PDS
      // This is a public endpoint, no authentication needed
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

        // If collection doesn't exist, return empty bookmarks
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

      // Enrich and filter bookmarks by tags
      const allBookmarks: EnrichedBookmark[] = data.records.map(
        (record: any) => ({
          uri: record.uri,
          cid: record.cid,
          subject: record.value.subject,
          createdAt: record.value.createdAt,
          tags: record.value.tags || [],
          title: record.value.$enriched?.title || record.value.title,
          description: record.value.$enriched?.description,
          favicon: record.value.$enriched?.favicon,
        }),
      );

      // Filter bookmarks that have ALL the specified tags (AND logic)
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
