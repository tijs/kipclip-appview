/**
 * Mirror upsert layer.
 *
 * Idempotent upsert + delete helpers. Used by webhook receiver (worker/webhook.ts)
 * and direct backfill paths.
 *
 * Idempotence: PRIMARY KEY on uri + INSERT…ON CONFLICT(uri) DO UPDATE replays the
 * same record cleanly. last_seq monotonically advances via MAX().
 *
 * Cross-DID guard: every upsert verifies the record's URI starts with `at://{did}/`
 * before writing — defends against caller bugs that would mix DIDs across rows.
 */

import { localDb, mirrorWrite, mirrorWriteEnabled, rawDb } from "../lib/db.ts";

export interface BookmarkUpsert {
  uri: string;
  did: string;
  rkey: string;
  cid: string;
  subject: string;
  createdAt: string;
  tags?: string[];
  enrichedTitle?: string | null;
  enrichedDescription?: string | null;
  enrichedFavicon?: string | null;
  enrichedImage?: string | null;
}

export interface AnnotationUpsert {
  uri: string;
  did: string;
  rkey: string;
  cid: string;
  subject: string;
  title?: string | null;
  description?: string | null;
  favicon?: string | null;
  image?: string | null;
  note?: string | null;
}

export interface TagUpsert {
  uri: string;
  did: string;
  rkey: string;
  cid: string;
  value: string;
  createdAt: string;
}

export interface PreferencesUpsert {
  did: string;
  cid: string;
  dateFormat?: string | null;
  readingListTag?: string | null;
}

export interface TrackedDidUpsert {
  did: string;
  pdsUrl?: string | null;
  backfillStartedAt?: number | null;
  backfillCompleteAt?: number | null;
  lastSeq?: number | null;
  lastEventAt?: number | null;
}

function assertDidMatchesUri(uri: string, did: string): void {
  const prefix = `at://${did}/`;
  if (!uri.startsWith(prefix)) {
    throw new Error(
      `URI ${uri} does not belong to DID ${did} (cross-DID guard)`,
    );
  }
}

export async function upsertBookmark(record: BookmarkUpsert): Promise<void> {
  assertDidMatchesUri(record.uri, record.did);
  const tagsJson = JSON.stringify(record.tags ?? []);
  await mirrorWrite({
    sql: `
      INSERT INTO bookmarks (
        uri, did, rkey, cid, subject, created_at, tags,
        enriched_title, enriched_description, enriched_favicon, enriched_image,
        pending_echo, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
      ON CONFLICT(uri) DO UPDATE SET
        did = excluded.did,
        rkey = excluded.rkey,
        cid = excluded.cid,
        subject = excluded.subject,
        created_at = excluded.created_at,
        tags = excluded.tags,
        enriched_title = excluded.enriched_title,
        enriched_description = excluded.enriched_description,
        enriched_favicon = excluded.enriched_favicon,
        enriched_image = excluded.enriched_image,
        pending_echo = 0,
        updated_at = excluded.updated_at
    `,
    args: [
      record.uri,
      record.did,
      record.rkey,
      record.cid,
      record.subject,
      record.createdAt,
      tagsJson,
      record.enrichedTitle ?? null,
      record.enrichedDescription ?? null,
      record.enrichedFavicon ?? null,
      record.enrichedImage ?? null,
      Date.now(),
    ],
  });
}

export async function deleteBookmark(uri: string, did: string): Promise<void> {
  assertDidMatchesUri(uri, did);
  await mirrorWrite({
    sql: "DELETE FROM bookmarks WHERE uri = ? AND did = ?",
    args: [uri, did],
  });
}

export async function upsertAnnotation(
  record: AnnotationUpsert,
): Promise<void> {
  assertDidMatchesUri(record.uri, record.did);
  await mirrorWrite({
    sql: `
      INSERT INTO annotations (
        uri, did, rkey, cid, subject,
        title, description, favicon, image, note,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(uri) DO UPDATE SET
        did = excluded.did,
        rkey = excluded.rkey,
        cid = excluded.cid,
        subject = excluded.subject,
        title = excluded.title,
        description = excluded.description,
        favicon = excluded.favicon,
        image = excluded.image,
        note = excluded.note,
        updated_at = excluded.updated_at
    `,
    args: [
      record.uri,
      record.did,
      record.rkey,
      record.cid,
      record.subject,
      record.title ?? null,
      record.description ?? null,
      record.favicon ?? null,
      record.image ?? null,
      record.note ?? null,
      Date.now(),
    ],
  });
}

export async function deleteAnnotation(
  uri: string,
  did: string,
): Promise<void> {
  assertDidMatchesUri(uri, did);
  await mirrorWrite({
    sql: "DELETE FROM annotations WHERE uri = ? AND did = ?",
    args: [uri, did],
  });
}

export async function upsertTag(record: TagUpsert): Promise<void> {
  assertDidMatchesUri(record.uri, record.did);
  await mirrorWrite({
    sql: `
      INSERT INTO tags (uri, did, rkey, cid, value, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(uri) DO UPDATE SET
        did = excluded.did,
        rkey = excluded.rkey,
        cid = excluded.cid,
        value = excluded.value,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at
    `,
    args: [
      record.uri,
      record.did,
      record.rkey,
      record.cid,
      record.value,
      record.createdAt,
      Date.now(),
    ],
  });
}

export async function deleteTag(uri: string, did: string): Promise<void> {
  assertDidMatchesUri(uri, did);
  await mirrorWrite({
    sql: "DELETE FROM tags WHERE uri = ? AND did = ?",
    args: [uri, did],
  });
}

export async function upsertPreferences(
  record: PreferencesUpsert,
): Promise<void> {
  await mirrorWrite({
    sql: `
      INSERT INTO preferences (did, cid, date_format, reading_list_tag, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(did) DO UPDATE SET
        cid = excluded.cid,
        date_format = excluded.date_format,
        reading_list_tag = excluded.reading_list_tag,
        updated_at = excluded.updated_at
    `,
    args: [
      record.did,
      record.cid,
      record.dateFormat ?? null,
      record.readingListTag ?? null,
      Date.now(),
    ],
  });
}

export async function deletePreferences(did: string): Promise<void> {
  await mirrorWrite({
    sql: "DELETE FROM preferences WHERE did = ?",
    args: [did],
  });
}

/**
 * Insert or update a tracked_dids row. Numeric fields advance monotonically
 * (last_seq, last_event_at) so out-of-order webhook deliveries don't regress.
 * On INSERT, added_at is stamped to now.
 */
export async function upsertTrackedDid(
  state: TrackedDidUpsert,
): Promise<void> {
  await mirrorWrite({
    sql: `
      INSERT INTO tracked_dids (
        did, pds_url, added_at,
        backfill_started_at, backfill_complete_at,
        last_seq, last_event_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(did) DO UPDATE SET
        pds_url = COALESCE(excluded.pds_url, tracked_dids.pds_url),
        backfill_started_at = COALESCE(
          excluded.backfill_started_at, tracked_dids.backfill_started_at
        ),
        backfill_complete_at = COALESCE(
          excluded.backfill_complete_at, tracked_dids.backfill_complete_at
        ),
        last_seq = MAX(
          COALESCE(excluded.last_seq, 0),
          COALESCE(tracked_dids.last_seq, 0)
        ),
        last_event_at = MAX(
          COALESCE(excluded.last_event_at, 0),
          COALESCE(tracked_dids.last_event_at, 0)
        )
    `,
    args: [
      state.did,
      state.pdsUrl ?? null,
      Date.now(),
      state.backfillStartedAt ?? null,
      state.backfillCompleteAt ?? null,
      state.lastSeq ?? null,
      state.lastEventAt ?? null,
    ],
  });
}

/**
 * Webhook replay protection. INSERT OR IGNORE returns rowsAffected = 1
 * the first time we see eventId, 0 on replays. Caller must skip
 * processing when this returns false — replaying a delete event after
 * the user re-created the record would silently re-delete it.
 *
 * Single-DB write: only the local mirror DB tracks seen events. Turso
 * doesn't need to know — the box is single-host, replay protection is a
 * box-local concern. Goes through mirrorWriteEnabled() so behavior in
 * dual-write-disabled mode (Turso-only) still gates on the rawDb copy.
 */
export async function markWebhookEventSeen(eventId: number): Promise<boolean> {
  const db = mirrorWriteEnabled() && localDb ? localDb : rawDb;
  const result = await db.execute({
    sql: `
      INSERT OR IGNORE INTO seen_webhook_events (event_id, seen_at)
      VALUES (?, ?)
    `,
    args: [eventId, Date.now()],
  });
  return result.rowsAffected === 1;
}

/**
 * GC seen_webhook_events older than the retention window. Called once
 * at module load (process restart on every release swap covers cadence)
 * so the table can't grow unbounded under steady webhook traffic.
 * Default retention: 7 days, well past TAP's longest backoff window.
 */
export async function gcSeenWebhookEvents(
  retentionMs = 7 * 24 * 60 * 60 * 1000,
): Promise<void> {
  const cutoff = Date.now() - retentionMs;
  const db = mirrorWriteEnabled() && localDb ? localDb : rawDb;
  try {
    await db.execute({
      sql: "DELETE FROM seen_webhook_events WHERE seen_at < ?",
      args: [cutoff],
    });
  } catch (err) {
    // GC is opportunistic — failure is logged but doesn't block the
    // process. Worst case the table grows a bit until next restart.
    console.warn("[webhook-gc] failed to prune seen_webhook_events:", err);
  }
}
