import { getHost } from "../runtime/host.ts";
import { db } from "./db.ts";
import {
  type EventAction,
  eventActions,
  eventSources,
} from "./event-actions.ts";
import { type AppEvent, backfillEventActions } from "./events.ts";

const LEASE_MS = 5 * 60_000;
let timer: ReturnType<typeof setInterval> | undefined;
let running = false;

export interface EventWorkerOptions {
  batchSize?: number;
  backfillLimit?: number;
  intervalMs?: number;
}

/** Atomic UPDATE RETURNING claims exactly one listener job across workers.
 * Finishes are guarded by the lease token, so an old worker cannot complete
 * a newer record version or a lease reclaimed after a restart. */
export async function runEventTick(
  options: EventWorkerOptions = {},
  actions: readonly Pick<EventAction, "id" | "run">[] = eventActions,
): Promise<
  {
    processed: number;
    success: number;
    retry: number;
    failed: number;
    backfilled: number;
  }
> {
  const stats = {
    processed: 0,
    success: 0,
    retry: 0,
    failed: 0,
    backfilled: 0,
  };
  if (running) return stats;
  running = true;
  try {
    stats.backfilled = await backfillEventActions(options.backfillLimit ?? 5);
    for (const source of eventSources) {
      stats.backfilled += await source(options.backfillLimit ?? 5);
    }
    for (let i = 0; i < (options.batchSize ?? 10); i++) {
      const now = Date.now();
      const token = crypto.randomUUID();
      const result = await db.execute({
        sql:
          `UPDATE event_action_jobs SET status = 'running', lease_token = ?, lease_until = ?
          WHERE (event_key, action) = (
            SELECT event_key, action FROM event_action_jobs
            WHERE (status = 'pending' AND next_run_at <= ?)
              OR (status = 'running' AND lease_until <= ?)
            ORDER BY next_run_at, event_key, action LIMIT 1
          ) RETURNING event_key, action, version, attempts`,
        args: [token, now + LEASE_MS, now, now],
      });
      if (!result.rows.length) break;
      const [key, actionId, version, attempts] = result.rows[0];
      stats.processed++;
      try {
        const eventRow = await db.execute({
          sql:
            `SELECT payload FROM app_events WHERE event_key = ? AND version = ?`,
          args: [key, version],
        });
        if (eventRow.rows.length) {
          const action = actions.find((item) => item.id === actionId);
          if (!action) throw new Error(`Unknown event action: ${actionId}`);
          await action.run(
            JSON.parse(String(eventRow.rows[0][0])) as AppEvent,
          );
        }
        await db.execute({
          sql:
            `UPDATE event_action_jobs SET status = 'done', lease_token = NULL,
            lease_until = 0, last_error = NULL WHERE event_key = ? AND action = ? AND lease_token = ?`,
          args: [key, actionId, token],
        });
        stats.success++;
      } catch (error) {
        const count = Number(attempts) + 1;
        const failed = count >= 5;
        await db.execute({
          sql:
            `UPDATE event_action_jobs SET status = ?, attempts = ?, next_run_at = ?,
            lease_token = NULL, lease_until = 0, last_error = ?
            WHERE event_key = ? AND action = ? AND lease_token = ?`,
          args: [
            failed ? "failed" : "pending",
            count,
            now + Math.min(6 * 60 * 60_000, 60_000 * 5 ** (count - 1)),
            error instanceof Error
              ? error.message.slice(0, 500)
              : "Event action failed",
            key,
            actionId,
            token,
          ],
        });
        if (failed) stats.failed++;
        else stats.retry++;
      }
    }
    if (stats.processed || stats.backfilled) {
      console.log("[event-actions] tick", stats);
    }
    return stats;
  } finally {
    running = false;
  }
}

export function startEventWorker(
  options: EventWorkerOptions = {},
): void {
  if (timer !== undefined || getHost().env.get("KIPCLIP_TESTING")) return;
  timer = setInterval(() => {
    runEventTick(options).catch((err) =>
      console.warn("[event-actions] tick failed", err)
    );
  }, options.intervalMs ?? 60_000);
}

export function stopEventWorker(): void {
  if (timer !== undefined) clearInterval(timer);
  timer = undefined;
}
