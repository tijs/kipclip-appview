/**
 * Shared PDS → mirror sync primitives.
 *
 * Fetch a tracked repo's records from its PDS and apply them to the local
 * mirror. Used by the enroll-time backfill (lib/auto-enroll.ts), the one-shot
 * recovery script, and the reconciling sync (lib/reconcile.ts).
 *
 * `fetchLiveRepo` is read-only against the PDS; `upsertLiveRepo` is the only
 * writer. Splitting the two lets the reconcile path compute add/delete deltas
 * (and run dry) from a single network pass, and — critically — lets the
 * reconciler do its destructive delete-missing step only AFTER a fully
 * successful read, so a transient PDS error can never wipe a mirror.
 */

import {
  upsertAnnotation,
  upsertBookmark,
  upsertPreferences,
  upsertTag,
} from "../mirror/upserts.ts";

// listRecords hits the user's PDS, which can be anywhere on the internet —
// give it a generous but bounded budget so a slow-loris PDS can't wedge a
// backfill/reconcile indefinitely.
export const PDS_FETCH_TIMEOUT_MS = 20_000;

export async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
}

// deno-lint-ignore no-explicit-any
type Record_ = any;

/** Page through every record in a collection. Throws on any non-2xx page so
 * a partial read never masquerades as an authoritative empty result. */
export async function listAll(
  pdsUrl: string,
  did: string,
  collection: string,
): Promise<Record_[]> {
  const records: Record_[] = [];
  let cursor: string | undefined;
  while (true) {
    const url = new URL(`${pdsUrl}/xrpc/com.atproto.repo.listRecords`);
    url.searchParams.set("repo", did);
    url.searchParams.set("collection", collection);
    url.searchParams.set("limit", "100");
    if (cursor) url.searchParams.set("cursor", cursor);
    const res = await fetchWithTimeout(
      url.toString(),
      { method: "GET" },
      PDS_FETCH_TIMEOUT_MS,
    );
    if (!res.ok) {
      throw new Error(`listRecords ${collection}: ${res.status}`);
    }
    const data = await res.json();
    const batch: Record_[] = data.records ?? [];
    records.push(...batch);
    cursor = data.cursor;
    if (!cursor || batch.length === 0) break;
  }
  return records;
}

function str(obj: unknown, key: string): string | undefined {
  if (obj && typeof obj === "object" && key in (obj as object)) {
    const v = (obj as Record<string, unknown>)[key];
    return typeof v === "string" ? v : undefined;
  }
}

function arr(val: unknown): string[] {
  if (!Array.isArray(val)) return [];
  return val.filter((x): x is string => typeof x === "string");
}

/** Collections that both land in the `annotations` mirror table. New writes
 * use com.kipclip.annotation; app.bookmark.annotation is the legacy form TAP
 * still ingests. The reconciler must union both before deleting, or it would
 * delete every legacy annotation as "missing". */
export interface LiveRepo {
  bookmarks: Record_[];
  kipclipAnnotations: Record_[];
  legacyAnnotations: Record_[];
  tags: Record_[];
  preferences: Record_[];
}

/** Read-only: fetch every tracked collection from the PDS in parallel.
 * Throws if any collection fails — callers must treat a throw as "do not
 * touch the mirror". */
export async function fetchLiveRepo(
  pdsUrl: string,
  did: string,
): Promise<LiveRepo> {
  const [bookmarks, kipclipAnnotations, legacyAnnotations, tags, preferences] =
    await Promise.all([
      listAll(pdsUrl, did, "community.lexicon.bookmarks.bookmark"),
      listAll(pdsUrl, did, "com.kipclip.annotation"),
      listAll(pdsUrl, did, "app.bookmark.annotation"),
      listAll(pdsUrl, did, "com.kipclip.tag"),
      listAll(pdsUrl, did, "com.kipclip.preferences"),
    ]);
  return {
    bookmarks,
    kipclipAnnotations,
    legacyAnnotations,
    tags,
    preferences,
  };
}

/** The set of AT-URIs the PDS currently holds, per mirror table. The
 * reconciler deletes any mirror row whose URI is absent from these sets. */
export interface LiveUris {
  bookmarks: Set<string>;
  annotations: Set<string>;
  tags: Set<string>;
  hasPreferences: boolean;
}

/** Derive the live URI sets without writing — used by reconcile --dry-run. */
export function liveUrisOf(repo: LiveRepo): LiveUris {
  return {
    bookmarks: new Set(repo.bookmarks.map((r) => r.uri as string)),
    annotations: new Set(
      [...repo.kipclipAnnotations, ...repo.legacyAnnotations].map(
        (r) => r.uri as string,
      ),
    ),
    tags: new Set(repo.tags.map((r) => r.uri as string)),
    hasPreferences: repo.preferences.length > 0,
  };
}

/** Upsert every record from a fetched repo into the mirror. Idempotent
 * (ON CONFLICT). Returns the live URI sets so the caller can compute the
 * delete-missing complement without a second pass. */
export async function upsertLiveRepo(
  did: string,
  repo: LiveRepo,
): Promise<LiveUris> {
  for (const r of repo.bookmarks) {
    const rkey = (r.uri as string).split("/").pop() ?? "";
    const v = r.value ?? {};
    const enriched = (v["$enriched"] as Record<string, unknown>) ?? {};
    await upsertBookmark({
      uri: r.uri,
      did,
      rkey,
      cid: r.cid,
      subject: str(v, "subject") ?? "",
      createdAt: str(v, "createdAt") ?? "",
      tags: arr(v["tags"]),
      enrichedTitle: str(enriched, "title") ?? str(v, "title") ?? null,
      enrichedDescription: str(enriched, "description") ?? null,
      enrichedFavicon: str(enriched, "favicon") ?? null,
      enrichedImage: str(enriched, "image") ?? null,
    });
  }

  for (const r of [...repo.kipclipAnnotations, ...repo.legacyAnnotations]) {
    const rkey = (r.uri as string).split("/").pop() ?? "";
    const v = r.value ?? {};
    await upsertAnnotation({
      uri: r.uri,
      did,
      rkey,
      cid: r.cid,
      subject: str(v, "subject") ?? "",
      title: str(v, "title") ?? null,
      description: str(v, "description") ?? null,
      favicon: str(v, "favicon") ?? null,
      image: str(v, "image") ?? null,
      note: str(v, "note") ?? null,
    });
  }

  for (const r of repo.tags) {
    const rkey = (r.uri as string).split("/").pop() ?? "";
    const v = r.value ?? {};
    await upsertTag({
      uri: r.uri,
      did,
      rkey,
      cid: r.cid,
      value: str(v, "value") ?? "",
      createdAt: str(v, "createdAt") ?? "",
    });
  }

  for (const r of repo.preferences) {
    const v = r.value ?? {};
    await upsertPreferences({
      did,
      cid: r.cid,
      dateFormat: str(v, "dateFormat") ?? null,
      readingListTag: str(v, "readingListTag") ?? null,
    });
  }

  return liveUrisOf(repo);
}
