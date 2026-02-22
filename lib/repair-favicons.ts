/**
 * Background repair: re-enriches annotations that are missing favicons.
 *
 * This fixes a bug where editing a bookmark (title, description, tags, etc.)
 * would wipe the favicon and image fields from the annotation sidecar.
 * The update handler was reading enrichment from $enriched on the bookmark
 * record (legacy storage) instead of the annotation, so annotations written
 * by the edit flow had favicon/image set to undefined.
 *
 * BACKGROUND TASK — triggered fire-and-forget from /api/initial-data.
 * Safe to remove once all active users have loaded the app at least once
 * after the fix landed (commit 678c36a, 2026-02-22).
 */

import { ANNOTATION_COLLECTION } from "./route-utils.ts";
import { extractUrlMetadata } from "./enrichment.ts";
import type { AnnotationRecord } from "../shared/types.ts";

/**
 * Find annotations missing favicons, re-fetch metadata, and patch them.
 */
export async function repairMissingFavicons(
  oauthSession: any,
  bookmarkRecords: any[],
  annotationMap: Map<string, AnnotationRecord>,
): Promise<void> {
  // Find bookmarks that have an annotation but the annotation lacks a favicon
  const needsRepair = bookmarkRecords.filter((record) => {
    const rkey = record.uri.split("/").pop();
    if (!rkey) return false;
    const annotation = annotationMap.get(rkey);
    if (!annotation) return false; // no annotation = handled by migration
    return !annotation.favicon;
  });

  if (needsRepair.length === 0) return;

  console.log(
    `Favicon repair: ${needsRepair.length} bookmarks to repair`,
  );

  // Process sequentially to be gentle on external sites
  let repaired = 0;
  for (const record of needsRepair) {
    const rkey = record.uri.split("/").pop();
    if (!rkey) continue;

    try {
      const metadata = await extractUrlMetadata(record.value.subject);
      if (!metadata.favicon) continue;

      const existing = annotationMap.get(rkey)!;
      const annotation: AnnotationRecord = {
        subject: existing.subject,
        title: existing.title || metadata.title,
        description: existing.description || metadata.description,
        favicon: metadata.favicon,
        image: existing.image || metadata.image,
        note: existing.note,
        createdAt: existing.createdAt,
      };

      const response = await oauthSession.makeRequest(
        "POST",
        `${oauthSession.pdsUrl}/xrpc/com.atproto.repo.putRecord`,
        {
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            repo: oauthSession.did,
            collection: ANNOTATION_COLLECTION,
            rkey,
            record: annotation,
          }),
        },
      );

      if (response.ok) repaired++;
    } catch (err) {
      console.error(`Favicon repair: error repairing ${rkey}:`, err);
    }
  }

  console.log(`Favicon repair: complete (${repaired}/${needsRepair.length})`);
}
