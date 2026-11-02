import { db } from "./db.ts";
import { eventActions } from "./event-actions.ts";
import type { BookmarkUpsert } from "../mirror/upserts.ts";

interface EventIdentity {
  /** Stable identity of the entity whose latest state the event represents. */
  key: string;
  /** CID for PDS records; a new token for local configuration changes. */
  version: string;
  did: string;
}

export interface BookmarkSavedEvent extends EventIdentity {
  type: "bookmark.saved";
  bookmark: BookmarkUpsert;
}

export interface ConfigurationChangedEvent extends EventIdentity {
  type: "preferences.changed" | "instapaper.connection.changed";
}

export type AppEvent = BookmarkSavedEvent | ConfigurationChangedEvent;
export type EventType = AppEvent["type"];
export interface Statement {
  sql: string;
  args: unknown[];
}

/** Publish facts in the same transaction as the state change. Each registered
 * subscriber gets an independent durable job. Repeated versions preserve
 * completion, attempts and backoff; a new version supersedes old pending work.
 * These are coalesced latest-state events, not a historical audit/event store. */
export function eventStatements(
  event: AppEvent,
  guard?: Statement,
): Statement[] {
  const now = Date.now();
  return [
    {
      sql:
        `INSERT INTO app_events (event_key, type, did, version, payload, updated_at)
      SELECT ?, ?, ?, ?, ?, ? WHERE ${guard?.sql ?? "1"}
      ON CONFLICT(event_key) DO UPDATE SET type = excluded.type,
        version = excluded.version, payload = excluded.payload, updated_at = excluded.updated_at`,
      args: [
        event.key,
        event.type,
        event.did,
        event.version,
        JSON.stringify(event),
        now,
        ...(guard?.args ?? []),
      ],
    },
    ...eventActions.filter((action) => action.events.includes(event.type)).map((
      action,
    ) => ({
      sql:
        `INSERT INTO event_action_jobs (event_key, action, version, status, attempts, next_run_at)
      SELECT event_key, ?, version, 'pending', 0, ? FROM app_events
      WHERE event_key = ? AND version = ?
      ON CONFLICT(event_key, action) DO UPDATE SET version = excluded.version,
        status = 'pending', attempts = 0, next_run_at = excluded.next_run_at,
        lease_token = NULL, lease_until = 0, last_error = NULL
      WHERE event_action_jobs.version != excluded.version`,
      args: [action.id, now, event.key, event.version],
    })),
  ];
}

/** A newly registered subscriber can catch up with any stored event type.
 * Domain backfills only discover source records; subscription repair belongs
 * here so future event types do not each need to implement that machinery. */
export async function backfillEventActions(limit = 5): Promise<number> {
  const args: unknown[] = [];
  const conditions = [
    ...new Set(eventActions.flatMap((action) => action.events)),
  ].map((type) => {
    const actions = eventActions.filter((action) =>
      action.events.includes(type)
    );
    args.push(type, ...actions.map((action) => action.id), actions.length);
    return `(e.type = ? AND (SELECT COUNT(*) FROM event_action_jobs j
      WHERE j.event_key = e.event_key AND j.version = e.version AND j.action IN (${
      actions.map(() => "?").join(",")
    })) < ?)`;
  });
  const rows = await db.execute({
    sql: `SELECT e.payload FROM app_events e WHERE ${conditions.join(" OR ")}
      ORDER BY e.updated_at, e.event_key LIMIT ?`,
    args: [...args, limit],
  });
  for (const [payload] of rows.rows) {
    const event = JSON.parse(String(payload)) as AppEvent;
    await db.batch(eventStatements(event, {
      sql:
        "EXISTS (SELECT 1 FROM app_events WHERE event_key = ? AND version = ?)",
      args: [event.key, event.version],
    }));
  }
  return rows.rows.length;
}

/** Re-evaluate a subscription after an explicit configuration change. Old
 * workers cannot finish the replacement job; external delivery leases and
 * history still prevent parallel sends and repeated successful deliveries. */
export async function requeueEventActionForDid(
  did: string,
  action: string,
): Promise<void> {
  await db.execute({
    sql: `UPDATE event_action_jobs SET status = 'pending', attempts = 0,
        next_run_at = ?, last_error = NULL, lease_token = NULL, lease_until = 0
      WHERE action = ? AND event_key IN (SELECT event_key FROM app_events WHERE did = ?)`,
    args: [Date.now(), action, did],
  });
}
