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
 *   "only"  - Reads served from mirror only. Untracked DIDs get empty results
 *             plus syncing flag. No PDS fallback.
 */

export type MirrorMode = "off" | "read" | "only";

const VALID_MODES: ReadonlySet<MirrorMode> = new Set(["off", "read", "only"]);

let cached: MirrorMode | null = null;

function readMode(): MirrorMode {
  const raw = Deno.env.get("MIRROR_MODE");
  if (!raw) return "off";
  const normalised = raw.trim().toLowerCase();
  if (VALID_MODES.has(normalised as MirrorMode)) {
    return normalised as MirrorMode;
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
