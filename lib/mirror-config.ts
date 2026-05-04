/**
 * MIRROR_MODE configuration.
 *
 * Read once from env at first call, then memoised. Controls whether read paths
 * serve from the local mirror or hit the user's PDS directly.
 *
 * Modes:
 *   "off"   - Default. All reads go to PDS. Mirror infra may exist but is unused.
 *   "read"  - Reads served from mirror for tracked DIDs with started backfill.
 *             Untracked DIDs fall through to PDS so login works before sync.
 *
 * Writes always go to the user's PDS. The mirror is purely a TAP-fed read
 * replica; there is no future "mirror is authoritative for writes" mode (see
 * docs/plans/2026-05-02-001-feat-appview-mirror-phases-0-2-plan.md, Terminal
 * architecture note). The legacy value "only" is rejected as invalid.
 */

import { getSyncStatus, type SyncStatus } from "../mirror/queries.ts";

export type MirrorMode = "off" | "read";

const VALID_MODES: ReadonlySet<MirrorMode> = new Set(["off", "read"]);

let cached: MirrorMode | null = null;

function readMode(): MirrorMode {
  const raw = Deno.env.get("MIRROR_MODE");
  if (!raw) return "off";
  const normalised = raw.trim().toLowerCase();
  if (VALID_MODES.has(normalised as MirrorMode)) {
    return normalised as MirrorMode;
  }
  if (normalised === "only") {
    console.warn(
      `⚠️ MIRROR_MODE="only" is no longer supported (mirror is read-only by design); falling back to "off"`,
    );
    return "off";
  }
  console.warn(
    `⚠️ MIRROR_MODE has invalid value "${raw}", falling back to "off"`,
  );
  return "off";
}

/** Returns the resolved mirror mode. Memoised after first call. */
export function getMirrorMode(): MirrorMode {
  if (cached === null) {
    cached = readMode();
  }
  return cached;
}

/** Reset cached mode. Test-only. */
export function _resetMirrorModeCache(): void {
  cached = null;
}

/** Log the active mode. Call once at app boot. */
export function logMirrorMode(): void {
  const mode = getMirrorMode();
  console.log(`🪞 MIRROR_MODE=${mode}`);
}

export interface MirrorReadDecision {
  /** True when handlers should serve from the mirror. */
  fromMirror: boolean;
  /** True when backfill is in progress for the DID. Stamp into response. */
  syncing: boolean;
  /** Cached sync status (saves a duplicate query in handlers). */
  status: SyncStatus;
}

/**
 * Decide whether a read for the given DID should hit the mirror.
 *
 *   "off"  → always false (PDS path).
 *   "read" → true iff DID is tracked AND backfill has started; otherwise PDS
 *            fallback so untracked users keep working.
 *
 * `syncing` is true when reading from the mirror but backfill_complete_at is
 * not yet stamped — the response advertises "data may be incomplete".
 */
export async function shouldReadFromMirror(
  did: string,
): Promise<MirrorReadDecision> {
  const mode = getMirrorMode();
  const status = await getSyncStatus(did);

  if (mode === "off") {
    return { fromMirror: false, syncing: false, status };
  }

  const fromMirror = status.tracking && status.backfillStartedAt !== null;
  return {
    fromMirror,
    syncing: fromMirror ? !status.backfillCompleteAt : false,
    status,
  };
}
