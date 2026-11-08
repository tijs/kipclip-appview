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
  sql: string | string[];
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
  {
    version: "009",
    description:
      "Backfill backfill_complete_at for enrolled DIDs stuck in syncing state",
    // touchTracked was previously UPDATE-only and didn't stamp backfill_complete_at,
    // leaving enrolled DIDs permanently stuck with syncing=true. Use last_event_at
    // as a proxy: if live events arrived after backfill started, backfill completed.
    sql: `
      UPDATE tracked_dids
        SET backfill_complete_at = last_event_at
      WHERE backfill_started_at IS NOT NULL
        AND backfill_complete_at IS NULL
        AND last_event_at IS NOT NULL
        AND last_event_at > backfill_started_at
    `,
  },
  {
    // Persistent record of every DID we've ever seen. Decouples the
    // marketing user count from iron_session_storage (which prunes
    // expired sessions) and the mirror tables (which only carry data
    // for tracked users). Backfilled from every existing DID-keyed
    // source on first run; subsequent inserts come from markSeenDid()
    // on the auth/session hot path. Lives in the mirror migration set
    // so it runs after bookmarks/tags/annotations/preferences exist.
    version: "010",
    description: "Create seen_dids and backfill from existing DID-keyed tables",
    sql: `
      CREATE TABLE IF NOT EXISTS seen_dids (
        did TEXT PRIMARY KEY,
        first_seen_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL
      );
      INSERT OR IGNORE INTO seen_dids (did, first_seen_at, last_seen_at)
        SELECT substr(key, 9), strftime('%s','now')*1000, strftime('%s','now')*1000
        FROM iron_session_storage
        WHERE key LIKE 'session:did:%';
      INSERT OR IGNORE INTO seen_dids (did, first_seen_at, last_seen_at)
        SELECT did, strftime('%s','now')*1000, strftime('%s','now')*1000
        FROM user_settings;
      INSERT OR IGNORE INTO seen_dids (did, first_seen_at, last_seen_at)
        SELECT did, strftime('%s','now')*1000, strftime('%s','now')*1000
        FROM tracked_dids;
      INSERT OR IGNORE INTO seen_dids (did, first_seen_at, last_seen_at)
        SELECT DISTINCT did, strftime('%s','now')*1000, strftime('%s','now')*1000
        FROM bookmarks;
      INSERT OR IGNORE INTO seen_dids (did, first_seen_at, last_seen_at)
        SELECT DISTINCT did, strftime('%s','now')*1000, strftime('%s','now')*1000
        FROM tags;
      INSERT OR IGNORE INTO seen_dids (did, first_seen_at, last_seen_at)
        SELECT DISTINCT did, strftime('%s','now')*1000, strftime('%s','now')*1000
        FROM annotations;
      INSERT OR IGNORE INTO seen_dids (did, first_seen_at, last_seen_at)
        SELECT did, strftime('%s','now')*1000, strftime('%s','now')*1000
        FROM preferences
    `,
  },
  {
    version: "011",
    description: "Create preview enrichment queue",
    sql: `
      CREATE TABLE IF NOT EXISTS preview_enrichment_jobs (
        bookmark_uri TEXT PRIMARY KEY,
        did TEXT NOT NULL,
        rkey TEXT NOT NULL,
        subject TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0,
        next_run_at INTEGER NOT NULL,
        last_error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_preview_jobs_runnable
        ON preview_enrichment_jobs(status, next_run_at);
      CREATE INDEX IF NOT EXISTS idx_preview_jobs_did
        ON preview_enrichment_jobs(did)
    `,
  },
  {
    version: "012",
    description: "Deduplicate TAP webhooks across reused event IDs",
    sql: `
      CREATE TABLE IF NOT EXISTS seen_webhook_deliveries (
        event_key TEXT PRIMARY KEY,
        seen_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_seen_webhook_deliveries_seen_at
        ON seen_webhook_deliveries(seen_at)
    `,
  },
  {
    version: "013",
    description: "Track repos confirmed missing for backoff and cleanup",
    sql: `
      CREATE TABLE IF NOT EXISTS missing_repos (
        did TEXT PRIMARY KEY,
        first_missing_at INTEGER NOT NULL,
        last_missing_at INTEGER NOT NULL,
        missing_count INTEGER NOT NULL DEFAULT 1,
        last_error TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_missing_repos_last_missing_at
        ON missing_repos(last_missing_at);
      CREATE INDEX IF NOT EXISTS idx_missing_repos_first_missing_at
        ON missing_repos(first_missing_at)
    `,
  },
  {
    version: "014",
    description:
      "Persisted TAP-repo classification: confirmed missing vs unavailable PDS with cooldown",
    sql: `
      CREATE TABLE IF NOT EXISTS tap_repo_state (
        did TEXT PRIMARY KEY,
        state TEXT NOT NULL,
        first_seen_at INTEGER NOT NULL,
        last_checked_at INTEGER NOT NULL,
        next_check_at INTEGER NOT NULL,
        failure_count INTEGER NOT NULL DEFAULT 1,
        last_error_class TEXT,
        last_error TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_tap_repo_state_state_next_check
        ON tap_repo_state(state, next_check_at)
    `,
  },
  {
    version: "015",
    description:
      "Durable application events, listener jobs and Instapaper delivery history",
    sql: `
      CREATE TABLE IF NOT EXISTS app_events (
        event_key TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        did TEXT NOT NULL,
        version TEXT NOT NULL,
        payload TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS event_action_jobs (
        event_key TEXT NOT NULL,
        action TEXT NOT NULL,
        version TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0,
        next_run_at INTEGER NOT NULL,
        lease_token TEXT,
        lease_until INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        PRIMARY KEY (event_key, action)
      );
      CREATE INDEX IF NOT EXISTS idx_event_actions_due
        ON event_action_jobs(status, next_run_at);
      CREATE INDEX IF NOT EXISTS idx_app_events_did
        ON app_events(did);
      CREATE TABLE IF NOT EXISTS instapaper_deliveries (
        bookmark_uri TEXT NOT NULL,
        subject TEXT NOT NULL,
        account_key TEXT NOT NULL,
        status TEXT NOT NULL,
        lease_token TEXT,
        lease_until INTEGER NOT NULL DEFAULT 0,
        delivered_at INTEGER,
        PRIMARY KEY (bookmark_uri, subject, account_key)
      )
    `,
  },
  {
    version: "017",
    description:
      "Track mirror mutation generations across all database writers",
    sql: [
      `CREATE TABLE IF NOT EXISTS mirror_generations (did TEXT PRIMARY KEY, generation INTEGER NOT NULL DEFAULT 0)`,
      ...["bookmarks", "annotations", "tags", "preferences"].flatMap((table) =>
        ["INSERT", "UPDATE", "DELETE"].map((op) =>
          `CREATE TRIGGER IF NOT EXISTS ${table}_generation_${op.toLowerCase()}
          AFTER ${op} ON ${table} BEGIN
            INSERT INTO mirror_generations (did, generation) VALUES (${
            op === "DELETE" ? "OLD" : "NEW"
          }.did, 1)
            ON CONFLICT(did) DO UPDATE SET generation = generation + 1;
          END`
        )
      ),
    ],
  },
  {
    version: "018",
    description: "Fence preview jobs to source revisions and leased owners",
    sql: `
      ALTER TABLE preview_enrichment_jobs ADD COLUMN source_cid TEXT NOT NULL DEFAULT '';
      ALTER TABLE preview_enrichment_jobs ADD COLUMN lease_token TEXT;
      ALTER TABLE preview_enrichment_jobs ADD COLUMN lease_until INTEGER NOT NULL DEFAULT 0;
      UPDATE preview_enrichment_jobs SET source_cid = COALESCE((SELECT cid FROM bookmarks WHERE uri = bookmark_uri), '')
    `,
  },
];
