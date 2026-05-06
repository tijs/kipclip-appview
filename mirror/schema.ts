/**
 * Mirror table schema migrations.
 *
 * Appended to lib/migrations.ts MIGRATIONS array. The runner splits each `sql`
 * by `;` and tolerates "already exists" errors per statement.
 *
 * Tables:
 *   bookmarks      — community.lexicon.bookmarks.bookmark records
 *   annotations    — app.bookmark.annotation sidecar records
 *   tags           — com.kipclip.tag records
 *   tracked_dids   — per-DID sync state, drives status endpoint
 *   preferences    — com.kipclip.preferences (one row per DID, rkey "self")
 */

export interface MigrationEntry {
  version: string;
  description: string;
  sql: string;
}

export const MIRROR_MIGRATIONS: MigrationEntry[] = [
  {
    version: "005",
    description:
      "Create mirror tables (bookmarks, annotations, tags, tracked_dids)",
    sql: `
      CREATE TABLE IF NOT EXISTS bookmarks (
        uri TEXT PRIMARY KEY,
        did TEXT NOT NULL,
        rkey TEXT NOT NULL,
        cid TEXT NOT NULL,
        subject TEXT NOT NULL,
        created_at TEXT NOT NULL,
        tags TEXT NOT NULL DEFAULT '[]',
        enriched_title TEXT,
        enriched_description TEXT,
        enriched_favicon TEXT,
        enriched_image TEXT,
        pending_echo INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS annotations (
        uri TEXT PRIMARY KEY,
        did TEXT NOT NULL,
        rkey TEXT NOT NULL,
        cid TEXT NOT NULL,
        subject TEXT NOT NULL,
        title TEXT,
        description TEXT,
        favicon TEXT,
        image TEXT,
        note TEXT,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS tags (
        uri TEXT PRIMARY KEY,
        did TEXT NOT NULL,
        rkey TEXT NOT NULL,
        cid TEXT NOT NULL,
        value TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS tracked_dids (
        did TEXT PRIMARY KEY,
        pds_url TEXT,
        added_at INTEGER NOT NULL,
        backfill_started_at INTEGER,
        backfill_complete_at INTEGER,
        last_seq INTEGER,
        last_event_at INTEGER
      )
    `,
  },
  {
    version: "006",
    description: "Create mirror indexes",
    sql: `
      CREATE INDEX IF NOT EXISTS idx_bookmarks_did_created
        ON bookmarks(did, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_annotations_did_subject
        ON annotations(did, subject);
      CREATE INDEX IF NOT EXISTS idx_annotations_subject
        ON annotations(subject);
      CREATE INDEX IF NOT EXISTS idx_tags_did_value
        ON tags(did, value)
    `,
  },
  {
    version: "007",
    description: "Create preferences mirror table (com.kipclip.preferences)",
    sql: `
      CREATE TABLE IF NOT EXISTS preferences (
        did TEXT PRIMARY KEY,
        cid TEXT NOT NULL,
        date_format TEXT,
        reading_list_tag TEXT,
        updated_at INTEGER NOT NULL
      )
    `,
  },
  {
    version: "008",
    description:
      "Create seen_webhook_events for replay protection on /api/sync/hook",
    sql: `
      CREATE TABLE IF NOT EXISTS seen_webhook_events (
        event_id INTEGER PRIMARY KEY,
        seen_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_seen_webhook_events_seen_at
        ON seen_webhook_events(seen_at)
    `,
  },
];
