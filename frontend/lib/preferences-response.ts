import type { UserPreferences } from "../../shared/types.ts";

/** Extract the preferences object returned by GET /api/preferences. */
export function preferencesFromResponse(
  value: unknown,
): UserPreferences | null {
  if (!value || typeof value !== "object" || !("preferences" in value)) {
    return null;
  }
  const preferences = value.preferences;
  if (!preferences || typeof preferences !== "object") return null;
  if (
    !("dateFormat" in preferences) ||
    typeof preferences.dateFormat !== "string" ||
    !("readingListTag" in preferences) ||
    typeof preferences.readingListTag !== "string"
  ) return null;
  return preferences as UserPreferences;
}

/** Apply only a complete preference payload from a successful live refetch. */
export async function refreshLivePreferences(
  fetchPreferences: () => Promise<Response>,
  apply: (preferences: UserPreferences) => void,
): Promise<void> {
  const response = await fetchPreferences();
  if (!response.ok) return;
  const preferences = preferencesFromResponse(await response.json());
  if (preferences) apply(preferences);
}
