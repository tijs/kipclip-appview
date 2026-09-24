/**
 * Annotation sidecar record helpers.
 * Handles reading and writing com.kipclip.annotation records on the PDS.
 */

import { ANNOTATION_COLLECTION, listAllRecords } from "./route-utils.ts";
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
    const records = await listAllRecords(oauthSession, ANNOTATION_COLLECTION);
    const map = new Map<string, AnnotationRecord>();
    for (const record of records) {
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

export interface WriteAnnotationResult {
  ok: boolean;
  uri?: string;
  cid?: string;
}

export interface WriteAnnotationOptions {
  /**
   * Expected CID of the record as currently stored on the PDS (putRecord's
   * swapRecord). When set, a concurrent edit between the caller's read and
   * this write makes the PDS reject the put (400 InvalidSwap) instead of
   * silently overwriting the newer record — the caller treats the failure as
   * retryable and re-reads before merging again.
   */
  swapRecord?: string;
}

/** Authoritative PDS annotation read: the record plus its CID for swapRecord. */
export interface PdsAnnotationRead {
  uri: string;
  cid: string;
  value: AnnotationRecord;
}

/**
 * Read the current annotation record from the authoritative PDS
 * (com.atproto.repo.getRecord) using the authenticated session and rkey.
 *
 * Returns null when the PDS has no such record (404) — the authoritative
 * "no annotation" answer. Any other failure throws so the caller retries
 * instead of merging/writing from a possibly stale mirror; a stale mirror
 * must never be used to overwrite after a PDS read error.
 */
export async function readAnnotationFromPds(
  oauthSession: any,
  rkey: string,
): Promise<PdsAnnotationRead | null> {
  let response: Response;
  try {
    const params = new URLSearchParams({
      repo: oauthSession.did,
      collection: ANNOTATION_COLLECTION,
      rkey,
    });
    response = await oauthSession.makeRequest(
      "GET",
      `${oauthSession.pdsUrl}/xrpc/com.atproto.repo.getRecord?${params}`,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `getRecord ${ANNOTATION_COLLECTION}/${rkey} failed: ${message}`,
    );
  }
  if (response.status === 404) return null;
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(
      `getRecord ${ANNOTATION_COLLECTION}/${rkey} failed: HTTP ` +
        `${response.status} ${detail}`,
    );
  }
  try {
    const data = await response.json();
    return {
      uri: data.uri,
      cid: data.cid,
      value: data.value as AnnotationRecord,
    };
  } catch {
    throw new Error(
      `getRecord ${ANNOTATION_COLLECTION}/${rkey} returned an invalid response`,
    );
  }
}

/**
 * Write an annotation sidecar record via putRecord (upsert).
 * Returns ok=false on failure (e.g. missing scope, InvalidSwap from a
 * concurrent edit when swapRecord was supplied). On success, returns
 * uri+cid so callers can mirror-upsert without a follow-up getRecord.
 */
export async function writeAnnotation(
  oauthSession: any,
  rkey: string,
  annotation: AnnotationRecord,
  options: WriteAnnotationOptions = {},
): Promise<WriteAnnotationResult> {
  const payload: Record<string, unknown> = {
    repo: oauthSession.did,
    collection: ANNOTATION_COLLECTION,
    rkey,
    record: annotation,
  };
  if (options.swapRecord) payload.swapRecord = options.swapRecord;
  try {
    const response = await oauthSession.makeRequest(
      "POST",
      `${oauthSession.pdsUrl}/xrpc/com.atproto.repo.putRecord`,
      {
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      },
    );
    if (!response.ok) return { ok: false };
    try {
      const data = await response.json();
      return { ok: true, uri: data.uri, cid: data.cid };
    } catch {
      return { ok: true };
    }
  } catch {
    return { ok: false };
  }
}
