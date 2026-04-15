/**
 * Saved login identities.
 * Stores recently used handles in localStorage for quick re-login.
 */

const STORAGE_KEY = "kipclip-saved-identities";
const MAX_IDENTITIES = 5;

export interface SavedIdentity {
  handle: string;
  did: string;
}

export function getSavedIdentities(): SavedIdentity[] {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) return [];
    const parsed = JSON.parse(stored);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item: unknown): item is SavedIdentity =>
        typeof item === "object" && item !== null &&
        typeof (item as SavedIdentity).handle === "string" &&
        typeof (item as SavedIdentity).did === "string",
    );
  } catch {
    return [];
  }
}

export function saveIdentity(handle: string, did: string) {
  try {
    const identities = getSavedIdentities();
    // Remove existing entry for this DID (handle may have changed)
    const filtered = identities.filter((id) => id.did !== did);
    // Add to front (most recent first)
    const updated = [{ handle, did }, ...filtered].slice(0, MAX_IDENTITIES);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
  } catch { /* localStorage unavailable */ }
}

export function removeIdentity(did: string) {
  try {
    const identities = getSavedIdentities();
    const updated = identities.filter((id) => id.did !== did);
    if (updated.length === 0) {
      localStorage.removeItem(STORAGE_KEY);
    } else {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
    }
  } catch { /* localStorage unavailable */ }
}
