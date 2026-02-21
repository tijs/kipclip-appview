/**
 * RSS feed routes.
 * Generates RSS feeds for shared bookmark collections.
 */

import type { App } from "@fresh/core";
import { resolveDid } from "../../lib/plc-resolver.ts";
import {
  ANNOTATION_COLLECTION,
  BOOKMARK_COLLECTION,
} from "../../lib/route-utils.ts";
import { decodeTagsFromUrl } from "../../shared/utils.ts";
import type { AnnotationRecord } from "../../shared/types.ts";

function escapeXml(unsafe: string): string {
  return unsafe
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function toRFC822Date(isoDate: string): string {
  return new Date(isoDate).toUTCString();
}

export function registerRssRoutes(app: App<any>): App<any> {
  app = app.get("/share/:did/:encodedTags/rss", async (ctx) => {
    try {
      const did = ctx.params.did;
      const encodedTags = ctx.params.encodedTags;

      const tags = decodeTagsFromUrl(encodedTags);
      if (!tags || tags.length === 0) {
        return new Response("Invalid tags", { status: 400 });
      }

      // Use cached PLC resolver
      const resolved = await resolveDid(did);
      if (!resolved) {
        return new Response("PDS not found", { status: 404 });
      }

      const { pdsUrl: pdsEndpoint, handle } = resolved;

      // Fetch bookmarks and annotations in parallel
      const [bookmarksResponse, annotationsResponse] = await Promise.all([
        fetch(
          `${pdsEndpoint}/xrpc/com.atproto.repo.listRecords?` +
            new URLSearchParams({
              repo: did,
              collection: BOOKMARK_COLLECTION,
              limit: "100",
            }),
        ),
        fetch(
          `${pdsEndpoint}/xrpc/com.atproto.repo.listRecords?` +
            new URLSearchParams({
              repo: did,
              collection: ANNOTATION_COLLECTION,
              limit: "100",
            }),
        ).catch(() => null),
      ]);

      if (!bookmarksResponse.ok) {
        return new Response("Failed to fetch bookmarks", { status: 500 });
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

      const bookmarksData = await bookmarksResponse.json();
      const filteredBookmarks = bookmarksData.records
        .filter((record: any) => {
          const recordTags = record.value?.tags || [];
          return tags.every((tag) => recordTags.includes(tag));
        })
        .map((record: any) => {
          const rkey = record.uri.split("/").pop();
          const annotation = rkey ? annotationMap.get(rkey) : undefined;
          return {
            uri: record.uri,
            cid: record.cid,
            subject: record.value.subject,
            createdAt: record.value.createdAt,
            tags: record.value.tags || [],
            title: annotation?.title || record.value.$enriched?.title,
            description: annotation?.description ||
              record.value.$enriched?.description,
          };
        })
        .sort(
          (a: any, b: any) =>
            new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
        );

      const tagsDisplay = tags.join(", ");
      const channelTitle = `${handle}'s ${tagsDisplay} bookmarks`;
      const channelDescription =
        `Bookmarks tagged with ${tagsDisplay} by ${handle}`;
      const channelLink = `https://kipclip.com/share/${did}/${encodedTags}`;
      const feedUrl = `https://kipclip.com/share/${did}/${encodedTags}/rss`;

      const items = filteredBookmarks
        .map((bookmark: any) => {
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
        })
        .join("\n");

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

      return new Response(rssXml, {
        headers: { "Content-Type": "application/rss+xml; charset=utf-8" },
      });
    } catch (error) {
      console.error("RSS generation error:", error);
      throw error;
    }
  });

  return app;
}
