/**
 * Public share endpoint. Returns bookmarks tagged with the given tags for
 * the given DID. Unauthenticated — all outbound PDS calls go through
 * `lib/pds-public.ts` for SSRF + DoS hardening.
 */

import type { App } from "@fresh/core";
import { resolveDid } from "../../lib/plc-resolver.ts";
import {
  ANNOTATION_COLLECTION,
  BOOKMARK_COLLECTION,
} from "../../lib/route-utils.ts";
import {
  assertSafePdsUrl,
  isValidDid,
  mapLimit,
  paginateListRecordsPublic,
  PdsListError,
} from "../../lib/pds-public.ts";
import { extractRkey, mapBookmarkRecord } from "../../lib/annotations.ts";
import { decodeTagsFromUrl } from "../../shared/utils.ts";
import type {
  AnnotationRecord,
  EnrichedBookmark,
  SharedBookmarksResponse,
} from "../../shared/types.ts";

const ANNOTATION_CONCURRENCY = 10;
/** Past this many matches it's cheaper to paginate annotations once. */
const ANNOTATION_PAGINATE_THRESHOLD = 50;

export function registerShareApiRoutes(app: App<any>): App<any> {
  app = app.get("/api/share/:did/:encodedTags", async (ctx) => {
    try {
      const did = ctx.params.did;
      const encodedTags = ctx.params.encodedTags;

      if (!isValidDid(did)) {
        return Response.json({ error: "Invalid DID" }, { status: 400 });
      }

      let tags: string[];
      try {
        tags = decodeTagsFromUrl(encodedTags);
      } catch (err: any) {
        return Response.json(
          { error: `Invalid tag encoding: ${err.message}` },
          { status: 400 },
        );
      }

      const resolved = await resolveDid(did);
      if (!resolved) {
        return Response.json({ error: "User not found" }, { status: 404 });
      }

      const { pdsUrl, handle } = resolved;

      // Validate PDS URL before we start fanning out fetches.
      try {
        assertSafePdsUrl(pdsUrl);
      } catch (err: any) {
        console.warn(`Rejecting PDS URL for ${did}: ${err.message}`);
        return Response.json({ error: "PDS not allowed" }, { status: 400 });
      }

      const bookmarkRecords = await paginateListRecordsPublic(
        pdsUrl,
        did,
        BOOKMARK_COLLECTION,
      );

      const matchingRecords = bookmarkRecords.filter((record: any) =>
        tags.every((tag) => (record.value.tags || []).includes(tag))
      );

      const annotationMap = await loadAnnotationMap(
        pdsUrl,
        did,
        matchingRecords,
      );

      const bookmarks: EnrichedBookmark[] = matchingRecords.map((record) => {
        const rkey = extractRkey(record.uri);
        return mapBookmarkRecord(
          record,
          rkey ? annotationMap.get(rkey) : undefined,
        );
      });

      const result: SharedBookmarksResponse = { bookmarks, handle, tags };
      return Response.json(result, {
        headers: {
          "Cache-Control": "public, max-age=60, stale-while-revalidate=600",
        },
      });
    } catch (error: any) {
      // Upstream "not found" / empty-repo cases are still 200 with empty
      // records on a healthy PDS, so any throw here is a real error.
      if (error instanceof PdsListError && error.status === 400) {
        // e.g. `repo not found` — surface as empty collection rather than 500.
        return Response.json(
          {
            bookmarks: [],
            handle: "",
            tags: [],
          } satisfies SharedBookmarksResponse,
        );
      }
      console.error("Error fetching shared bookmarks:", error);
      return Response.json(
        { error: "Failed to fetch shared bookmarks" },
        { status: 500 },
      );
    }
  });

  return app;
}

/**
 * Load annotations for matched bookmarks.
 *
 * For large match sets, paginating the annotation collection once is cheaper
 * than N per-rkey `getRecord` calls. For small match sets, the fan-out is
 * faster and avoids fetching unrelated annotations.
 */
async function loadAnnotationMap(
  pdsUrl: string,
  did: string,
  matchingRecords: any[],
): Promise<Map<string, AnnotationRecord>> {
  const map = new Map<string, AnnotationRecord>();
  if (matchingRecords.length === 0) return map;

  const matchedRkeys = matchingRecords
    .map((r) => extractRkey(r.uri))
    .filter((k): k is string => !!k);

  if (matchedRkeys.length > ANNOTATION_PAGINATE_THRESHOLD) {
    try {
      const annotations = await paginateListRecordsPublic(
        pdsUrl,
        did,
        ANNOTATION_COLLECTION,
      );
      for (const record of annotations) {
        const rkey = extractRkey(record.uri);
        if (rkey) map.set(rkey, record.value as AnnotationRecord);
      }
    } catch (err) {
      console.warn("Failed to paginate annotations:", err);
    }
    return map;
  }

  await mapLimit(matchedRkeys, ANNOTATION_CONCURRENCY, async (rkey) => {
    const params = new URLSearchParams({
      repo: did,
      collection: ANNOTATION_COLLECTION,
      rkey,
    });
    const res = await fetch(
      `${pdsUrl}/xrpc/com.atproto.repo.getRecord?${params}`,
      { redirect: "error", signal: AbortSignal.timeout(5000) },
    ).catch(() => null);
    if (res?.ok) {
      const data = await res.json();
      if (data?.value) {
        map.set(rkey, data.value as AnnotationRecord);
      }
    }
  });

  return map;
}
