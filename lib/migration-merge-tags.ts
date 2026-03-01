/**
 * Shared logic for merging duplicate tags (case-insensitive).
 *
 * Used by:
 * - Background PDS migration (runs on page load)
 * - Manual merge endpoint (POST /api/tags/merge-duplicates)
 */

import { BOOKMARK_COLLECTION, TAG_COLLECTION } from "./route-utils.ts";
import { tagsEqual } from "../shared/tag-utils.ts";
import type { MergeTagDuplicatesResponse } from "../shared/types.ts";

/**
 * Merge case-insensitive duplicate tags.
 * Keeps the earliest-created tag as canonical, updates bookmarks to use
 * the canonical casing, and deletes duplicate tag records.
 */
export async function mergeTagDuplicates(
  oauthSession: any,
  tagRecords: any[],
  bookmarkRecords: any[],
): Promise<MergeTagDuplicatesResponse> {
  // Group tags by lowercase value
  const groups = new Map<string, typeof tagRecords>();
  for (const rec of tagRecords) {
    const value = rec.value?.value;
    if (!value) continue;
    const key = value.toLowerCase();
    const group = groups.get(key) || [];
    group.push(rec);
    groups.set(key, group);
  }

  // Find groups with duplicates
  const duplicateGroups = [...groups.entries()].filter(([_, g]) =>
    g.length > 1
  );

  if (duplicateGroups.length === 0) {
    return { merged: 0, tagsDeleted: 0, bookmarksUpdated: 0, details: [] };
  }

  let tagsDeleted = 0;
  let bookmarksUpdated = 0;
  const details: MergeTagDuplicatesResponse["details"] = [];

  for (const [_, group] of duplicateGroups) {
    // Keep the earliest-created tag as canonical
    group.sort((a: any, b: any) =>
      (a.value.createdAt || "").localeCompare(b.value.createdAt || "")
    );
    const canonical = group[0];
    const duplicates = group.slice(1);
    const canonicalValue = canonical.value.value;
    const duplicateValues = duplicates.map((d: any) => d.value.value);

    // Update bookmarks: replace all variant casings with canonical
    const affectedBookmarks = bookmarkRecords.filter((rec: any) =>
      rec.value.tags?.some((t: string) =>
        tagsEqual(t, canonicalValue) && t !== canonicalValue
      )
    );

    for (const bookmark of affectedBookmarks) {
      const bookmarkRkey = bookmark.uri.split("/").pop();
      // Replace all case variants with canonical, then deduplicate
      const seen = new Set<string>();
      const updatedTags: string[] = [];
      for (const t of bookmark.value.tags) {
        const val = tagsEqual(t, canonicalValue) ? canonicalValue : t;
        const lower = val.toLowerCase();
        if (!seen.has(lower)) {
          seen.add(lower);
          updatedTags.push(val);
        }
      }

      await oauthSession.makeRequest(
        "POST",
        `${oauthSession.pdsUrl}/xrpc/com.atproto.repo.putRecord`,
        {
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            repo: oauthSession.did,
            collection: BOOKMARK_COLLECTION,
            rkey: bookmarkRkey,
            record: { ...bookmark.value, tags: updatedTags },
          }),
        },
      ).catch((err: any) =>
        console.error(
          `Failed to update bookmark ${bookmarkRkey}:`,
          err,
        )
      );
      bookmarksUpdated++;
    }

    // Delete duplicate tag records
    for (const dup of duplicates) {
      const dupRkey = dup.uri.split("/").pop();
      await oauthSession.makeRequest(
        "POST",
        `${oauthSession.pdsUrl}/xrpc/com.atproto.repo.deleteRecord`,
        {
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            repo: oauthSession.did,
            collection: TAG_COLLECTION,
            rkey: dupRkey,
          }),
        },
      ).catch((err: any) =>
        console.error(`Failed to delete tag ${dupRkey}:`, err)
      );
      tagsDeleted++;
    }

    details.push({
      canonical: canonicalValue,
      merged: duplicateValues,
      bookmarksUpdated: affectedBookmarks.length,
    });
  }

  return {
    merged: duplicateGroups.length,
    tagsDeleted,
    bookmarksUpdated,
    details,
  };
}
