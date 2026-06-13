/**
 * Write-side PDS-migration guard.
 *
 * After a user migrates their repo to a new PDS, their existing kipclip OAuth
 * session is still bound to the OLD PDS: `session.pdsUrl` points there and the
 * DPoP access token was issued by the old PDS's authorization server. Writes
 * (`oauthSession.makeRequest(...)` against `session.pdsUrl`) therefore land on
 * the dead/old repo — which is exactly why vicwalker.dev.br's in-app deletes
 * "did nothing". The token can't be repointed at the new PDS without a fresh
 * OAuth login, and forging one by hand would be an auth workaround — so the
 * only correct response is to force re-authentication.
 *
 * This compares the session's bound PDS host against the DID's CURRENT PDS,
 * resolved authoritatively from the DID document. A different host means the
 * session predates a migration and the caller must re-auth.
 *
 * Fail-open by design: any resolution error, timeout, unparseable URL, or
 * unresolvable DID returns `migrated: false`. A PLC outage must never log users
 * out — the reconciler + drift monitor are the correctness backstop.
 */

import { resolveDid } from "./plc-resolver.ts";

// Confirmed-match cache. Keeps PLC off the write hot path: once a DID's session
// host is verified against its current PDS, skip re-resolving for the TTL.
// Migrations are rare, so a stale window here only delays the re-auth prompt by
// at most TTL — harmless, and the reconciler keeps the mirror correct meanwhile.
const TTL_MS = 60 * 60 * 1000; // 1 hour
const confirmedMatch = new Map<string, { host: string; checkedAt: number }>();

// Bound the hot-path cost so a slow PLC can't wedge a write. On timeout we
// fail open (treat as not-migrated) rather than block the user.
const RESOLVE_TIMEOUT_MS = 3_000;

// Compare by hostname, NOT host: `new URL(u).host` keeps an explicit port, so a
// session bound to `https://pds.example.com` and a DID-doc endpoint published as
// `https://pds.example.com:443` would read as a migration and wrongly force
// re-auth. A real migration always changes the hostname.
function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

// Resolve the DID's current PDS with a hard timeout. The AbortController both
// bounds the wait AND cancels the underlying plc.directory request, so a slow
// PLC can't pile up abandoned in-flight sockets on the write path. resolveDid
// swallows the resulting AbortError and returns null → caller fails open.
async function resolveCurrentPds(did: string) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RESOLVE_TIMEOUT_MS);
  try {
    return await resolveDid(did, controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

export interface PdsMigrationResult {
  migrated: boolean;
  /** The DID's current PDS — set only when a migration is detected. */
  currentPdsUrl?: string;
}

/**
 * Returns `migrated: true` when the DID's current PDS is a different host than
 * the one the session is bound to. See module docs for the fail-open contract.
 */
export async function checkPdsMigration(
  did: string,
  sessionPdsUrl: string,
): Promise<PdsMigrationResult> {
  const sessionHost = hostOf(sessionPdsUrl);
  if (!sessionHost) return { migrated: false };

  const cached = confirmedMatch.get(did);
  if (
    cached && cached.host === sessionHost &&
    Date.now() - cached.checkedAt < TTL_MS
  ) {
    return { migrated: false };
  }

  const resolved = await resolveCurrentPds(did);
  if (!resolved) return { migrated: false }; // fail-open on unresolvable/slow DID
  const currentHost = hostOf(resolved.pdsUrl);
  if (!currentHost) return { migrated: false };

  if (currentHost === sessionHost) {
    confirmedMatch.set(did, { host: sessionHost, checkedAt: Date.now() });
    return { migrated: false };
  }

  // Different host: the session is bound to a PDS the account no longer uses.
  return { migrated: true, currentPdsUrl: resolved.pdsUrl };
}

/** HTTP methods that write to the user's PDS via the session. Reads (GET/HEAD)
 * serve from the local mirror and never touch the PDS, so they're exempt from
 * the migration check entirely — keeping the read hot path PLC-free. */
function isMutation(method: string): boolean {
  const m = method.toUpperCase();
  return m === "POST" || m === "PUT" || m === "PATCH" || m === "DELETE";
}

export interface MigrationDecision {
  /** Auth error to return (request must be blocked) — set only when a mutating
   * request is bound to a PDS the user migrated away from. */
  block?: { type: string; message: string };
  /** The authoritative PDS to persist to tracked_dids, or null when there's no
   * fresh value to write (the read path skips PLC, so it returns null). */
  refreshPdsUrl: string | null;
  /** Resolved current PDS when a migration was detected (for logging). */
  currentPdsUrl?: string;
}

/**
 * Single per-request decision for the session path. Resolves the DID's current
 * PDS once (cached) and drives BOTH outputs from that one authoritative result:
 *
 *   - `refreshPdsUrl`: what to store in tracked_dids. We only hand back the
 *     session's own pdsUrl after confirming it still matches the DID document;
 *     for a migrated-but-not-re-authed user that value is stale, so we hand back
 *     the resolved current host instead. This is why the session path no longer
 *     trusts `session.pdsUrl` blindly.
 *   - `block`: present when a MUTATING request is bound to a PDS the user left,
 *     so the caller forces re-auth.
 *
 * Reads short-circuit before any PLC call (exempt + read hot path stays
 * network-free) and return `refreshPdsUrl: null` so the caller skips the
 * tracked_dids write rather than persisting a possibly-stale host.
 */
export async function evaluatePdsMigration(
  method: string,
  did: string,
  sessionPdsUrl: string,
): Promise<MigrationDecision> {
  if (!isMutation(method)) return { refreshPdsUrl: null };

  const migration = await checkPdsMigration(did, sessionPdsUrl);
  if (!migration.migrated) {
    // session.pdsUrl confirmed current → safe to persist.
    return { refreshPdsUrl: sessionPdsUrl };
  }
  return {
    refreshPdsUrl: migration.currentPdsUrl ?? null,
    currentPdsUrl: migration.currentPdsUrl,
    block: {
      type: "PDS_MIGRATED",
      message:
        "You moved your account to a new server. Please sign in again to keep saving.",
    },
  };
}

/** Test-only: clear the confirmed-match cache between cases. */
export function _resetPdsMigrationCache(): void {
  confirmedMatch.clear();
}
