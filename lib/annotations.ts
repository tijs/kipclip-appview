/**
 * Annotation sidecar record helpers.
 * Handles reading and writing com.kipclip.annotation records on the PDS.
 */

import { ANNOTATION_COLLECTION } from "./route-utils.ts";
import type { AnnotationRecord, EnrichedBookmark } from "../shared/types.ts";

/**
 * Extract rkey from an AT Protocol URI.
 * e.g. "at://did:plc:abc/collection/rkey123" → "rkey123"
 */
export function extractRkey(uri: string): string | undefined {
  return uri.split("/").pop();
}

/**
 * Merge annotation data onto a bookmark record.
 * Falls back to $enriched on the bookmark if no annotation exists.
 */
export function mapBookmarkRecord(
  record: any,
  annotation?: AnnotationRecord,
): EnrichedBookmark {
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
}

/**
 * Fetch all annotation records and build an rkey → annotation lookup map.
 */
export async function fetchAnnotationMap(
  oauthSession: any,
): Promise<{ map: Map<string, AnnotationRecord>; ok: boolean }> {
  try {
    const params = new URLSearchParams({
      repo: oauthSession.did,
      collection: ANNOTATION_COLLECTION,
      limit: "100",
    });
    const response = await oauthSession.makeRequest(
      "GET",
      `${oauthSession.pdsUrl}/xrpc/com.atproto.repo.listRecords?${params}`,
    );

    if (!response.ok) {
      return { map: new Map(), ok: false };
    }

    const data = await response.json();
    const map = new Map<string, AnnotationRecord>();
    for (const record of data.records || []) {
      const rkey = extractRkey(record.uri);
      if (rkey) {
        map.set(rkey, record.value as AnnotationRecord);
      }
    }
    return { map, ok: true };
  } catch {
    return { map: new Map(), ok: false };
  }
}

/**
 * Write an annotation sidecar record via putRecord (upsert).
 * Returns true on success, false on failure (e.g. missing scope).
 */
export async function writeAnnotation(
  oauthSession: any,
  rkey: string,
  annotation: AnnotationRecord,
): Promise<boolean> {
  try {
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
    return response.ok;
  } catch {
    return false;
  }
}
