/**
 * Per-month marketing metrics — calendar-month MAU and signups for the
 * last N months. Companion to lib/stats.ts (lifetime totals); both are
 * consumed by the side-business dashboard for monthly bar charts.
 *
 * Sources:
 *   - mau:     COUNT(DISTINCT key) on iron_session_storage where
 *              key LIKE 'session:did:%' AND updated_at falls in the
 *              month's UTC range. Bounded by the 14-day session TTL —
 *              months older than ~2 weeks back will be partial and will
 *              continue to decay as iron-session evicts sessions. Only
 *              the current calendar month is fully meaningful; callers
 *              who want a frozen historical view should write each
 *              month's MAU once and stop overwriting past values.
 *   - signups: COUNT(*) on seen_dids where first_seen_at falls in the
 *              month. Accurate going forward; the seen_dids backfill
 *              migration stamped all pre-existing rows with the
 *              migration timestamp, so the first month covered by the
 *              backfill shows an outsized spike. Document this in the
 *              consumer.
 *
 * Cached for 1h (much shorter than /api/stats because per-month MAU
 * shifts intra-day as new sessions land).
 */

import { db } from "./db.ts";
import { type CachedFetcher, createCachedFetcher } from "./cached-fetch.ts";

const TTL_MS = 60 * 60 * 1000;
const DEFAULT_MONTHS = 12;
export const MAX_MONTHS = 24;

export interface MonthlyStatsRow {
  yearMonth: string;
  mau: number;
  signups: number;
}

export interface MonthlyStats {
  months: MonthlyStatsRow[];
  /** Inclusive current-month label, e.g. "2026-05". */
  currentYearMonth: string;
}

function toNumber(raw: unknown): number {
  const n = typeof raw === "number"
    ? raw
    : typeof raw === "bigint"
    ? Number(raw)
    : Number(raw ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function ymToUtcRangeMs(yearMonth: string): { startMs: number; endMs: number } {
  const [y, m] = yearMonth.split("-").map(Number);
  return { startMs: Date.UTC(y, m - 1, 1), endMs: Date.UTC(y, m, 1) };
}

function recentYearMonths(now: Date, count: number): string[] {
  const out: string[] = [];
  for (let i = count - 1; i >= 0; i--) {
    const d = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1),
    );
    out.push(
      `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`,
    );
  }
  return out;
}

const MAU_SQL = `
  SELECT COUNT(DISTINCT key) AS n
  FROM iron_session_storage
  WHERE key LIKE 'session:did:%'
    AND updated_at != ''
    AND CAST(updated_at AS INTEGER) >= ?
    AND CAST(updated_at AS INTEGER) < ?
`;

const SIGNUPS_SQL = `
  SELECT COUNT(*) AS n
  FROM seen_dids
  WHERE first_seen_at >= ?
    AND first_seen_at < ?
`;

async function fetchMonthlyStats(
  months: number,
  now: Date,
): Promise<MonthlyStats> {
  const yms = recentYearMonths(now, months);
  const rows = await Promise.all(yms.map(async (ym) => {
    const { startMs, endMs } = ymToUtcRangeMs(ym);
    const [mauRows, signupsRows] = await Promise.all([
      db.execute({ sql: MAU_SQL, args: [startMs, endMs] }),
      db.execute({ sql: SIGNUPS_SQL, args: [startMs, endMs] }),
    ]);
    return {
      yearMonth: ym,
      mau: toNumber(mauRows.rows?.[0]?.[0]),
      signups: toNumber(signupsRows.rows?.[0]?.[0]),
    };
  }));
  return {
    months: rows,
    currentYearMonth: yms[yms.length - 1],
  };
}

interface FetcherEntry {
  months: number;
  fetcher: CachedFetcher<MonthlyStats>;
}

// One cached fetcher per requested window. The dashboard only ever asks
// for one value of `months` so this set stays bounded to a handful of
// entries even in pathological cases — capped via MAX_MONTHS at the
// route layer.
const fetchers: FetcherEntry[] = [];

export function getMonthlyStats(
  months: number = DEFAULT_MONTHS,
): Promise<{ data: MonthlyStats; stale: boolean }> {
  const clamped = Math.min(Math.max(1, Math.floor(months)), MAX_MONTHS);
  let entry = fetchers.find((f) => f.months === clamped);
  if (!entry) {
    entry = {
      months: clamped,
      fetcher: createCachedFetcher({
        ttlMs: TTL_MS,
        fetch: () => fetchMonthlyStats(clamped, new Date()),
        fallback: { months: [], currentYearMonth: "" },
        label: `stats-monthly-${clamped}`,
      }),
    };
    fetchers.push(entry);
  }
  return entry.fetcher.get();
}

export const __testing__ = {
  fetchMonthlyStats,
  recentYearMonths,
  ymToUtcRangeMs,
  resetCache(): void {
    fetchers.length = 0;
  },
};
