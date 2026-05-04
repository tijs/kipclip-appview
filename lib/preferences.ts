/**
 * User preferences stored on PDS (com.kipclip.preferences).
 * Uses a single record with rkey "self" for per-user preferences.
 *
 * Read path is mirror-aware: when MIRROR_MODE=read and the caller's DID is
 * tracked AND the mirror has a row for that DID, read from the mirror table
 * (TAP keeps it in sync). Otherwise fall through to PDS.
 */

import { shouldReadFromMirror } from "./mirror-config.ts";
import { getMirrorPreferences } from "../mirror/queries.ts";
import { PREFERENCES_COLLECTION } from "./route-utils.ts";
import type { UserPreferences } from "../shared/types.ts";

const DEFAULT_PREFERENCES: UserPreferences = {
  dateFormat: "us",
  readingListTag: "toread",
};

/**
 * Fetch user preferences. Reads from the local mirror when available;
 * otherwise hits the PDS. Returns defaults on 404 or error.
 */
export async function getUserPreferences(
  oauthSession: any,
): Promise<UserPreferences> {
  const decision = await shouldReadFromMirror(oauthSession.did);
  if (decision.fromMirror) {
    const mirrored = await getMirrorPreferences(oauthSession.did);
    if (mirrored) {
      return {
        dateFormat: mirrored.dateFormat || DEFAULT_PREFERENCES.dateFormat,
        readingListTag: mirrored.readingListTag ||
          DEFAULT_PREFERENCES.readingListTag,
      };
    }
    // Tracked but mirror has no preferences row yet (TAP backfill in progress
    // or user hasn't set any preferences). Fall through to PDS so the user
    // sees their real settings rather than blank defaults.
  }

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
      readingListTag: data.value?.readingListTag ||
        DEFAULT_PREFERENCES.readingListTag,
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
          readingListTag: merged.readingListTag,
          createdAt: new Date().toISOString(),
        },
      }),
    },
  );

  return merged;
}
