import type { App } from "jsr:@fresh/core@^2.2.0";

// Fresh App with any state type (we don't use Fresh's state management)
type FreshApp = App<any>;
import { decodeTagsFromUrl } from "../../shared/utils.ts";

const BOOKMARK_COLLECTION = "community.lexicon.bookmarks.bookmark";

/**
 * Escapes special XML characters to prevent invalid XML
 */
function escapeXml(unsafe: string): string {
  return unsafe
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Formats a date string to RFC 822 format required by RSS
 */
function toRFC822Date(isoDate: string): string {
  const date = new Date(isoDate);
  return date.toUTCString();
}

/**
 * Register RSS routes on the Fresh app
 */
export function registerRssRoutes(app: FreshApp): FreshApp {
  /**
   * Generates RSS 2.0 XML feed for a bookmark collection
   */
  app = app.get("/share/:did/:encodedTags/rss", async (ctx) => {
    try {
      const did = ctx.params.did;
      const encodedTags = ctx.params.encodedTags;

      // Decode tags from URL
      const tags = decodeTagsFromUrl(encodedTags);

      if (!tags || tags.length === 0) {
        return new Response("Invalid tags", { status: 400 });
      }

      // Resolve DID to PDS endpoint
      const didDoc = await fetch(
        `https://plc.directory/${did}`,
      ).then((r) => r.json());

      const pdsEndpoint = didDoc.service?.find((s: any) =>
        s.type === "AtprotoPersonalDataServer"
      )?.serviceEndpoint;

      if (!pdsEndpoint) {
        return new Response("PDS not found", { status: 404 });
      }

      // Get handle from DID document
      const handle = didDoc.alsoKnownAs?.[0]?.replace("at://", "") || did;

      // Fetch bookmarks from PDS
      const bookmarksResponse = await fetch(
        `${pdsEndpoint}/xrpc/com.atproto.repo.listRecords?` +
          new URLSearchParams({
            repo: did,
            collection: BOOKMARK_COLLECTION,
            limit: "100",
          }),
      );

      if (!bookmarksResponse.ok) {
        return new Response("Failed to fetch bookmarks", { status: 500 });
      }

      const bookmarksData = await bookmarksResponse.json();

      // Filter bookmarks by tags
      const filteredBookmarks = bookmarksData.records
        .filter((record: any) => {
          const recordTags = record.value?.tags || [];
          return tags.every((tag) => recordTags.includes(tag));
        })
        .map((record: any) => ({
          uri: record.uri,
          cid: record.cid,
          subject: record.value.subject,
          createdAt: record.value.createdAt,
          tags: record.value.tags || [],
          title: record.value.$enriched?.title,
          description: record.value.$enriched?.description,
          favicon: record.value.$enriched?.favicon,
        }))
        .sort((a: any, b: any) =>
          new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
        );

      // Generate RSS feed metadata
      const tagsDisplay = tags.join(", ");
      const channelTitle = `${handle}'s ${tagsDisplay} bookmarks`;
      const channelDescription =
        `Bookmarks tagged with ${tagsDisplay} by ${handle}`;
      const channelLink = `https://kipclip.com/share/${did}/${encodedTags}`;
      const feedUrl = `https://kipclip.com/share/${did}/${encodedTags}/rss`;

      // Build RSS XML
      const items = filteredBookmarks.map((bookmark: any) => {
        const title = escapeXml(bookmark.title || bookmark.subject);
        const description = escapeXml(
          bookmark.description || "No description available",
        );
        const link = escapeXml(bookmark.subject);
        const pubDate = toRFC822Date(bookmark.createdAt);
        const guid = escapeXml(bookmark.uri);

        return `    <item>
      <title>${title}</title>
      <link>${link}</link>
      <description>${description}</description>
      <pubDate>${pubDate}</pubDate>
      <guid isPermaLink="false">${guid}</guid>
    </item>`;
      }).join("\n");

      const rssXml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${escapeXml(channelTitle)}</title>
    <link>${escapeXml(channelLink)}</link>
    <description>${escapeXml(channelDescription)}</description>
    <language>en</language>
    <atom:link href="${
        escapeXml(feedUrl)
      }" rel="self" type="application/rss+xml" />
${items}
  </channel>
</rss>`;

      // Return RSS XML with proper content type
      return new Response(rssXml, {
        status: 200,
        headers: {
          "Content-Type": "application/rss+xml; charset=utf-8",
        },
      });
    } catch (error) {
      console.error("RSS generation error:", error);
      throw error; // Re-throw to get full stack trace
    }
  });

  return app;
}
