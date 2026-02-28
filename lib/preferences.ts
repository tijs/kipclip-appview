/**
 * User preferences stored on PDS (com.kipclip.preferences).
 * Uses a single record with rkey "self" for per-user preferences.
 */

import { PREFERENCES_COLLECTION } from "./route-utils.ts";
import type { UserPreferences } from "../shared/types.ts";

const DEFAULT_PREFERENCES: UserPreferences = {
  dateFormat: "us",
};

/**
 * Fetch user preferences from PDS. Returns defaults on 404 or error
 * (e.g. missing OAuth scope for users who haven't re-authenticated).
 */
export async function getUserPreferences(
  oauthSession: any,
): Promise<UserPreferences> {
  try {
    const params = new URLSearchParams({
      repo: oauthSession.did,
      collection: PREFERENCES_COLLECTION,
      rkey: "self",
    });

    const res = await oauthSession.makeRequest(
      "GET",
      `${oauthSession.pdsUrl}/xrpc/com.atproto.repo.getRecord?${params}`,
    );

    if (!res.ok) {
      return { ...DEFAULT_PREFERENCES };
    }

    const data = await res.json();
    return {
      dateFormat: data.value?.dateFormat || DEFAULT_PREFERENCES.dateFormat,
    };
  } catch {
    return { ...DEFAULT_PREFERENCES };
  }
}

/**
 * Update user preferences on PDS. Merges updates with existing values
 * and upserts via putRecord.
 */
export async function updateUserPreferences(
  oauthSession: any,
  updates: Partial<UserPreferences>,
): Promise<UserPreferences> {
  const existing = await getUserPreferences(oauthSession);
  const merged: UserPreferences = { ...existing, ...updates };

  await oauthSession.makeRequest(
    "POST",
    `${oauthSession.pdsUrl}/xrpc/com.atproto.repo.putRecord`,
    {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        repo: oauthSession.did,
        collection: PREFERENCES_COLLECTION,
        rkey: "self",
        record: {
          dateFormat: merged.dateFormat,
          createdAt: new Date().toISOString(),
        },
      }),
    },
  );

  return merged;
}
