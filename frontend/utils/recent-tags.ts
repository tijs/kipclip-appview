/**
 * Recent tags tracker.
 * Tracks the last N tag values the user has touched (filtered, applied to a
 * bookmark, removed) so the sidebar can surface them above the alphabetical
 * list. Stored per-device in localStorage; not synced to PDS.
 */

const STORAGE_KEY = "kipclip:recent-tags";
export const MAX_RECENT_TAGS = 8;

export function loadRecentTags(): string[] {
  if (typeof localStorage === "undefined") return [];
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) return [];
    const parsed = JSON.parse(stored);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is string => typeof v === "string");
  } catch {
    return [];
  }
}

export function saveRecentTags(tags: string[]): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(tags));
  } catch { /* localStorage unavailable or quota exceeded */ }
}

/**
 * Compute the next recent-tags list after the user touches `tagValue`.
 * Removes any case-insensitive match for the value, then unshifts the new
 * value preserving its original casing, and clips to MAX_RECENT_TAGS.
 */
export function nextRecentTags(current: string[], tagValue: string): string[] {
  const trimmed = tagValue.trim();
  if (!trimmed) return current;
  const lower = trimmed.toLowerCase();
  const filtered = current.filter((t) => t.toLowerCase() !== lower);
  return [trimmed, ...filtered].slice(0, MAX_RECENT_TAGS);
}
