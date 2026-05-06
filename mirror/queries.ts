/**
 * Mirror read-side query layer.
 *
 * Returns rows shaped as EnrichedBookmark / EnrichedTag from shared/types.ts so
 * route handlers can swap data sources behind MIRROR_MODE without translating.
 *
 * Bookmark queries LEFT JOIN annotations ON annotations.subject = bookmarks.uri
 * — the annotation sidecar references the bookmark URI, not the rkey, so this
 * is the authoritative join.
 *
 * Pagination uses (created_at, uri) as the sort key. Cursor format: an opaque
 * base64-ish string `${created_at}|${uri}`. Ties on created_at are broken by
 * URI lexicographic ordering, so pagination is stable across page boundaries.
 */

import { mirrorRead, rawDb } from "../lib/db.ts";
import type { EnrichedBookmark, EnrichedTag } from "../shared/types.ts";

export interface SyncStatus {
  tracking: boolean;
  pdsUrl: string | null;
  backfillStartedAt: number | null;
  backfillCompleteAt: number | null;
  lastSeq: number | null;
  lastEventAt: number | null;
}

export interface FirstPageOpts {
  /** Hard cap on rows returned. Defaults to 50 to match PDS first-page size. */
  limit?: number;
}

export interface PageResult {
  bookmarks: EnrichedBookmark[];
  /** Cursor for the next page; undefined when no more rows. */
  cursor?: string;
}

const DEFAULT_PAGE_SIZE = 50;

const BOOKMARK_SELECT = `
  SELECT
    b.uri, b.cid, b.subject, b.created_at, b.tags,
    b.enriched_title, b.enriched_description, b.enriched_favicon, b.enriched_image,
    a.title AS a_title,
    a.description AS a_description,
    a.favicon AS a_favicon,
    a.image AS a_image,
    a.note AS a_note
  FROM bookmarks b
  LEFT JOIN annotations a ON a.subject = b.uri
`;

function rowToBookmark(row: unknown[]): EnrichedBookmark {
  const [
    uri,
    cid,
    subject,
    createdAt,
    tagsJson,
    eTitle,
    eDescription,
    eFavicon,
    eImage,
    aTitle,
    aDescription,
    aFavicon,
    aImage,
    aNote,
  ] = row as (string | number | null)[];
  let tags: string[] = [];
  if (tagsJson) {
    try {
      const parsed = JSON.parse(String(tagsJson));
      if (Array.isArray(parsed)) {
        tags = parsed.filter((t) => typeof t === "string");
      }
    } catch {
      tags = [];
    }
  }
  return {
    uri: String(uri),
    cid: String(cid),
    subject: String(subject),
    createdAt: String(createdAt),
    tags,
    title: (aTitle as string | null) ?? (eTitle as string | null) ?? undefined,
    description: (aDescription as string | null) ??
      (eDescription as string | null) ?? undefined,
    favicon: (aFavicon as string | null) ?? (eFavicon as string | null) ??
      undefined,
    image: (aImage as string | null) ?? (eImage as string | null) ?? undefined,
    note: (aNote as string | null) ?? undefined,
  };
}

function encodeCursor(createdAt: string, uri: string): string {
  return `${createdAt}|${uri}`;
}

function decodeCursor(
  cursor: string,
): { createdAt: string; uri: string } | null {
  const idx = cursor.indexOf("|");
  if (idx <= 0) return null;
  return {
    createdAt: cursor.slice(0, idx),
    uri: cursor.slice(idx + 1),
  };
}

/**
 * First page of bookmarks for a DID, newest-first.
 */
export async function firstPageBookmarks(
  did: string,
  opts: FirstPageOpts = {},
): Promise<PageResult> {
  const limit = opts.limit ?? DEFAULT_PAGE_SIZE;
  const r = await mirrorRead((db) =>
    db.execute({
      sql: `${BOOKMARK_SELECT}
          WHERE b.did = ?
          ORDER BY b.created_at DESC, b.uri DESC
          LIMIT ?`,
      args: [did, limit + 1],
    })
  );
  const rows = r.rows ?? [];
  const hasMore = rows.length > limit;
  const slice = hasMore ? rows.slice(0, limit) : rows;
  const bookmarks = slice.map(rowToBookmark);
  const cursor = hasMore && bookmarks.length > 0
    ? encodeCursor(
      bookmarks[bookmarks.length - 1].createdAt,
      bookmarks[bookmarks.length - 1].uri,
    )
    : undefined;
  return { bookmarks, cursor };
}

/**
 * Next page after the cursor returned by a prior firstPageBookmarks /
 * nextPageBookmarks call. Stable across boundaries via (created_at, uri).
 */
export async function nextPageBookmarks(
  did: string,
  cursor: string,
  opts: FirstPageOpts = {},
): Promise<PageResult> {
  const decoded = decodeCursor(cursor);
  if (!decoded) return { bookmarks: [], cursor: undefined };
  const limit = opts.limit ?? DEFAULT_PAGE_SIZE;
  const r = await mirrorRead((db) =>
    db.execute({
      sql: `${BOOKMARK_SELECT}
          WHERE b.did = ?
            AND (
              b.created_at < ?
              OR (b.created_at = ? AND b.uri < ?)
            )
          ORDER BY b.created_at DESC, b.uri DESC
          LIMIT ?`,
      args: [did, decoded.createdAt, decoded.createdAt, decoded.uri, limit + 1],
    })
  );
  const rows = r.rows ?? [];
  const hasMore = rows.length > limit;
  const slice = hasMore ? rows.slice(0, limit) : rows;
  const bookmarks = slice.map(rowToBookmark);
  const nextCursor = hasMore && bookmarks.length > 0
    ? encodeCursor(
      bookmarks[bookmarks.length - 1].createdAt,
      bookmarks[bookmarks.length - 1].uri,
    )
    : undefined;
  return { bookmarks, cursor: nextCursor };
}

/**
 * All bookmarks for a DID, newest-first. Used by /api/bookmarks list endpoint
 * which returns the full set in one response.
 */
export async function listAllBookmarks(
  did: string,
): Promise<EnrichedBookmark[]> {
  const r = await mirrorRead((db) =>
    db.execute({
      sql: `${BOOKMARK_SELECT}
          WHERE b.did = ?
          ORDER BY b.created_at DESC, b.uri DESC`,
      args: [did],
    })
  );
  return (r.rows ?? []).map(rowToBookmark);
}

/** Single bookmark by URI, joined with its annotation sidecar. */
export async function getBookmark(
  uri: string,
): Promise<EnrichedBookmark | null> {
  const r = await mirrorRead((db) =>
    db.execute({
      sql: `${BOOKMARK_SELECT} WHERE b.uri = ?`,
      args: [uri],
    })
  );
  if (!r.rows || r.rows.length === 0) return null;
  return rowToBookmark(r.rows[0]);
}

/** Single tag by URI. */
export async function getTag(uri: string): Promise<EnrichedTag | null> {
  const r = await mirrorRead((db) =>
    db.execute({
      sql: "SELECT uri, cid, value, created_at FROM tags WHERE uri = ?",
      args: [uri],
    })
  );
  if (!r.rows || r.rows.length === 0) return null;
  const [u, cid, value, createdAt] = r.rows[0] as (string | null)[];
  return {
    uri: String(u),
    cid: String(cid),
    value: String(value),
    createdAt: String(createdAt),
  };
}

export interface EnrichedAnnotation {
  uri: string;
  cid: string;
  subject: string;
  title: string | null;
  description: string | null;
  favicon: string | null;
  image: string | null;
  note: string | null;
}

/** Single annotation sidecar by URI. */
export async function getAnnotation(
  uri: string,
): Promise<EnrichedAnnotation | null> {
  const r = await mirrorRead((db) =>
    db.execute({
      sql: `SELECT uri, cid, subject, title, description, favicon, image, note
         FROM annotations WHERE uri = ?`,
      args: [uri],
    })
  );
  if (!r.rows || r.rows.length === 0) return null;
  const [u, cid, subject, title, description, favicon, image, note] = r
    .rows[0] as (string | null)[];
  return {
    uri: String(u),
    cid: String(cid),
    subject: String(subject),
    title: title as string | null,
    description: description as string | null,
    favicon: favicon as string | null,
    image: image as string | null,
    note: note as string | null,
  };
}

/** All tags for a DID. */
export async function listTags(did: string): Promise<EnrichedTag[]> {
  const r = await mirrorRead((db) =>
    db.execute({
      sql: `SELECT uri, cid, value, created_at FROM tags WHERE did = ?
          ORDER BY value`,
      args: [did],
    })
  );
  return (r.rows ?? []).map((row) => {
    const [uri, cid, value, createdAt] = row as (string | null)[];
    return {
      uri: String(uri),
      cid: String(cid),
      value: String(value),
      createdAt: String(createdAt),
    };
  });
}

export interface MirrorPreferences {
  dateFormat: string | null;
  readingListTag: string | null;
}

/**
 * Read the user's mirrored preferences. Returns null when no row exists yet
 * so callers can fall back to defaults or to a PDS read.
 */
export async function getMirrorPreferences(
  did: string,
): Promise<MirrorPreferences | null> {
  const r = await mirrorRead((db) =>
    db.execute({
      sql:
        "SELECT date_format, reading_list_tag FROM preferences WHERE did = ?",
      args: [did],
    })
  );
  if (!r.rows || r.rows.length === 0) return null;
  const [dateFormat, readingListTag] = r.rows[0] as (string | null)[];
  return {
    dateFormat: dateFormat ?? null,
    readingListTag: readingListTag ?? null,
  };
}

export interface MirrorInitialExtras {
  /** Raw user_settings row data (caller decrypts username and applies defaults). */
  instapaperEnabled: boolean;
  instapaperUsernameEncrypted: string | null;
  /** Mirrored preferences row, or null when no row exists yet. */
  preferences: MirrorPreferences | null;
}

/**
 * Combined read of user_settings + preferences in a single Turso roundtrip.
 *
 * /api/initial-data's mirror branch needs both, and they previously fired as
 * two parallel HTTP requests — the libSQL HTTP client serializes per-connection
 * so the second roundtrip pays full latency. One LEFT JOIN against a literal
 * DID row produces both in one call. Caller decrypts the username and applies
 * UserSettings defaults; preferences callers apply their own defaults.
 *
 * Stays on Turso (rawDb) deliberately: user_settings is Turso-only durable
 * state (not mirrored via TAP), so this JOIN can't run against the local
 * libSQL where user_settings doesn't exist. Future optimization: split prefs
 * from settings, read prefs via mirrorRead for sub-ms latency, settings still
 * Turso. Out of scope for plan 004.
 */
export async function getMirrorInitialExtras(
  did: string,
): Promise<MirrorInitialExtras> {
  const r = await rawDb.execute({
    sql: `SELECT
            s.instapaper_enabled,
            s.instapaper_username_encrypted,
            p.date_format,
            p.reading_list_tag,
            CASE WHEN p.did IS NULL THEN 0 ELSE 1 END AS has_prefs
          FROM (SELECT ? AS did) d
          LEFT JOIN user_settings s ON s.did = d.did
          LEFT JOIN preferences p ON p.did = d.did`,
    args: [did],
  });
  const row = (r.rows?.[0] ?? []) as (string | number | null)[];
  const [
    instapaperEnabled,
    instapaperUsernameEncrypted,
    dateFormat,
    readingListTag,
    hasPrefs,
  ] = row;
  return {
    instapaperEnabled: instapaperEnabled === 1 || instapaperEnabled === "1",
    instapaperUsernameEncrypted: instapaperUsernameEncrypted
      ? String(instapaperUsernameEncrypted)
      : null,
    preferences: hasPrefs
      ? {
        dateFormat: (dateFormat as string | null) ?? null,
        readingListTag: (readingListTag as string | null) ?? null,
      }
      : null,
  };
}

/** Per-DID sync state. tracking=false when no row exists. */
export async function getSyncStatus(did: string): Promise<SyncStatus> {
  const r = await mirrorRead((db) =>
    db.execute({
      sql: `SELECT pds_url, backfill_started_at, backfill_complete_at,
                 last_seq, last_event_at
          FROM tracked_dids WHERE did = ?`,
      args: [did],
    })
  );
  if (!r.rows || r.rows.length === 0) {
    return {
      tracking: false,
      pdsUrl: null,
      backfillStartedAt: null,
      backfillCompleteAt: null,
      lastSeq: null,
      lastEventAt: null,
    };
  }
  const [pdsUrl, started, complete, seq, eventAt] = r
    .rows[0] as (string | number | null)[];
  return {
    tracking: true,
    pdsUrl: (pdsUrl as string | null) ?? null,
    backfillStartedAt: started === null ? null : Number(started),
    backfillCompleteAt: complete === null ? null : Number(complete),
    lastSeq: seq === null ? null : Number(seq),
    lastEventAt: eventAt === null ? null : Number(eventAt),
  };
}
