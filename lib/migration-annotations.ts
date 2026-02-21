/**
 * Background migration: moves $enriched data from bookmark records
 * to annotation sidecar records.
 *
 * Triggered fire-and-forget from /api/initial-data after the response is sent.
 * Only runs if the annotation scope is available.
 */

import { ANNOTATION_COLLECTION, BOOKMARK_COLLECTION } from "./route-utils.ts";
import type { AnnotationRecord } from "../shared/types.ts";

const BATCH_SIZE = 5;

/**
 * Find bookmarks with $enriched data that lack a corresponding annotation,
 * create the annotation, and clean the bookmark record.
 */
export async function migrateAnnotations(
  oauthSession: any,
  bookmarkRecords: any[],
  annotationMap: Map<string, AnnotationRecord>,
): Promise<void> {
  // Find bookmarks that need migration:
  // - Have $enriched data or top-level title
  // - Don't have a corresponding annotation
  const needsMigration = bookmarkRecords.filter((record) => {
    const rkey = record.uri.split("/").pop();
    if (!rkey) return false;
    if (annotationMap.has(rkey)) return false;
    return record.value.$enriched || record.value.title;
  });

  if (needsMigration.length === 0) return;

  console.log(
    `Annotation migration: ${needsMigration.length} bookmarks to migrate`,
  );

  // Process in batches to avoid rate limits
  for (let i = 0; i < needsMigration.length; i += BATCH_SIZE) {
    const batch = needsMigration.slice(i, i + BATCH_SIZE);

    await Promise.all(batch.map(async (record: any) => {
      const rkey = record.uri.split("/").pop();
      if (!rkey) return;

      try {
        const enriched = record.value.$enriched || {};

        // Create annotation sidecar
        const annotation: AnnotationRecord = {
          subject: record.uri,
          title: enriched.title || record.value.title,
          description: enriched.description,
          favicon: enriched.favicon,
          image: enriched.image,
          createdAt: record.value.createdAt,
        };

        const annResponse = await oauthSession.makeRequest(
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

        if (!annResponse.ok) {
          console.error(`Migration: failed to create annotation for ${rkey}`);
          return;
        }

        // Clean the bookmark record (remove $enriched and top-level title)
        const cleanRecord: Record<string, unknown> = {
          subject: record.value.subject,
          createdAt: record.value.createdAt,
          tags: record.value.tags || [],
        };

        await oauthSession.makeRequest(
          "POST",
          `${oauthSession.pdsUrl}/xrpc/com.atproto.repo.putRecord`,
          {
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              repo: oauthSession.did,
              collection: BOOKMARK_COLLECTION,
              rkey,
              record: cleanRecord,
            }),
          },
        );
      } catch (err) {
        console.error(`Migration: error migrating bookmark ${rkey}:`, err);
      }
    }));

    // Small delay between batches
    if (i + BATCH_SIZE < needsMigration.length) {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }

  console.log("Annotation migration: complete");
}
