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
