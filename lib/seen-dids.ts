/**
 * seen_dids — persistent ledger of every DID that ever signed in to
 * kipclip. Decouples the marketing user count from short-lived
 * sources like iron_session_storage (sessions get evicted on expiry)
 * or the mirror tables (only carry rows for tracked users).
 *
 * Insertions happen on the auth/session hot path via markSeenDid().
 * Reads happen from lib/stats.ts via countSeenDids().
 */

import { db } from "./db.ts";

/**
 * Upsert this DID into seen_dids. Cheap: PRIMARY KEY conflict path
 * only updates last_seen_at. Safe to call on every authenticated
 * request. Errors are swallowed so an auth response is never blocked
 * by a metrics write.
 */
export async function markSeenDid(did: string): Promise<void> {
  if (!did || !did.startsWith("did:")) return;
  const now = Date.now();
  try {
    await db.execute({
      sql: `
        INSERT INTO seen_dids (did, first_seen_at, last_seen_at)
        VALUES (?, ?, ?)
        ON CONFLICT(did) DO UPDATE SET last_seen_at = excluded.last_seen_at
      `,
      args: [did, now, now],
    });
  } catch (err) {
    console.warn("[seen-dids] mark failed:", (err as Error).message);
  }
}

/** Total distinct DIDs ever seen. */
export async function countSeenDids(): Promise<number> {
  const result = await db.execute({
    sql: "SELECT COUNT(*) FROM seen_dids",
    args: [],
  });
  const raw = result.rows?.[0]?.[0];
  const n = typeof raw === "number"
    ? raw
    : typeof raw === "bigint"
    ? Number(raw)
    : Number(raw ?? 0);
  return Number.isFinite(n) ? n : 0;
}

/**
 * DIDs active in the trailing window — defined as last_seen_at within
 * the last `windowMs` milliseconds. Useful for "active users last 30d"
 * once the table has accumulated enough history.
 */
export async function countActiveSeenDids(
  windowMs: number,
): Promise<number> {
  const cutoff = Date.now() - windowMs;
  const result = await db.execute({
    sql: "SELECT COUNT(*) FROM seen_dids WHERE last_seen_at >= ?",
    args: [cutoff],
  });
  const raw = result.rows?.[0]?.[0];
  const n = typeof raw === "number"
    ? raw
    : typeof raw === "bigint"
    ? Number(raw)
    : Number(raw ?? 0);
  return Number.isFinite(n) ? n : 0;
}
