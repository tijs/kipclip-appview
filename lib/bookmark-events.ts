import { db } from "./db.ts";
import { eventStatements, type Statement } from "./events.ts";
import type { BookmarkUpsert } from "../mirror/upserts.ts";

/** Shared record boundary for direct writes, TAP and backfill. The guard keeps
 * a historical scan from overwriting an event for a newer mirror revision. */
export function bookmarkEventStatements(bookmark: BookmarkUpsert): Statement[] {
  return eventStatements({
    type: "bookmark.saved",
    key: bookmark.uri,
    version: bookmark.cid,
    did: bookmark.did,
    bookmark,
  }, {
    sql: "EXISTS (SELECT 1 FROM bookmarks WHERE uri = ? AND cid = ?)",
    args: [bookmark.uri, bookmark.cid],
  });
}

/** Discover pre-existing mirror rows and new registered actions in small batches. */
export async function backfillBookmarkEvents(limit = 5): Promise<number> {
  const result = await db.execute({
    sql: `SELECT b.uri, b.did, b.rkey, b.cid, b.subject, b.created_at,
        b.tags, b.enriched_title, b.enriched_description, b.enriched_favicon, b.enriched_image
      FROM bookmarks b LEFT JOIN app_events e ON e.event_key = b.uri
      WHERE e.event_key IS NULL OR e.version != b.cid
      ORDER BY b.created_at DESC, b.uri LIMIT ?`,
    args: [limit],
  });
  for (const row of result.rows) {
    const bookmark: BookmarkUpsert = {
      uri: String(row[0]),
      did: String(row[1]),
      rkey: String(row[2]),
      cid: String(row[3]),
      subject: String(row[4]),
      createdAt: String(row[5]),
      tags: JSON.parse(String(row[6])),
      enrichedTitle: row[7] as string | null,
      enrichedDescription: row[8] as string | null,
      enrichedFavicon: row[9] as string | null,
      enrichedImage: row[10] as string | null,
    };
    await db.batch(bookmarkEventStatements(bookmark));
  }
  return result.rows.length;
}
