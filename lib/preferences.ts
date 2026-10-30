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
import { validateDomainTagRules } from "../shared/domain-tag-rules.ts";

const DEFAULT_PREFERENCES: UserPreferences = {
  dateFormat: "us",
  readingListTag: "toread",
};

export class PreferenceConflictError extends Error {}

async function isRecordNotFound(response: Response): Promise<boolean> {
  if (response.status !== 400 && response.status !== 404) return false;
  try {
    return (await response.clone().json()).error === "RecordNotFound";
  } catch {
    return false;
  }
}

/** Read the authoritative trigger before sending a bookmark to a third party.
 * Unknown or unavailable preferences must not be guessed from a stale mirror. */
export async function getAuthoritativeReadingListTag(
  oauthSession: any,
): Promise<string | null> {
  const params = new URLSearchParams({
    repo: oauthSession.did,
    collection: PREFERENCES_COLLECTION,
    rkey: "self",
  });
  try {
    const response = await oauthSession.makeRequest(
      "GET",
      `${oauthSession.pdsUrl}/xrpc/com.atproto.repo.getRecord?${params}`,
    );
    if (!response.ok) {
      return await isRecordNotFound(response)
        ? DEFAULT_PREFERENCES.readingListTag
        : null;
    }
    const record = await response.json();
    if (
      !record.value || typeof record.value !== "object" ||
      Array.isArray(record.value)
    ) {
      return null;
    }
    const tag = record.value.readingListTag;
    if (tag === undefined) return DEFAULT_PREFERENCES.readingListTag;
    return typeof tag === "string" && tag.trim() ? tag : null;
  } catch {
    return null;
  }
}

/** Domain rules are read from the PDS directly because the existing mirror
 * stores only the older preference fields. */
export async function getDomainTagRules(oauthSession: any) {
  const params = new URLSearchParams({
    repo: oauthSession.did,
    collection: PREFERENCES_COLLECTION,
    rkey: "self",
  });
  const response = await oauthSession.makeRequest(
    "GET",
    `${oauthSession.pdsUrl}/xrpc/com.atproto.repo.getRecord?${params}`,
  );
  if (!response.ok && await isRecordNotFound(response)) {
    return { rules: [], cid: null };
  }
  if (!response.ok) {
    throw new Error("Could not read domain rules from your PDS");
  }
  const record = await response.json();
  const rules = record.value?.domainTagRules ?? [];
  if (!validateDomainTagRules(rules)) {
    throw new Error("Invalid domain rules in your PDS");
  }
  if (typeof record.cid !== "string") {
    throw new Error("PDS omitted the preference revision");
  }
  return { rules, cid: record.cid as string | null };
}

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
export async function writeUserPreferences(
  oauthSession: any,
  updates: Partial<UserPreferences>,
  expectedCid?: string | null,
): Promise<{ preferences: UserPreferences; cid: string | null }> {
  // Write against the authoritative PDS record, not a potentially stale mirror.
  // Preserve fields introduced by other clients and reject concurrent changes.
  const params = new URLSearchParams({
    repo: oauthSession.did,
    collection: PREFERENCES_COLLECTION,
    rkey: "self",
  });
  const current = await oauthSession.makeRequest(
    "GET",
    `${oauthSession.pdsUrl}/xrpc/com.atproto.repo.getRecord?${params}`,
  );
  if (!current.ok && !(await isRecordNotFound(current))) {
    throw new Error("Could not read preferences from your PDS");
  }
  const existing = current.ok ? await current.json() : null;
  if (expectedCid !== undefined && (existing?.cid ?? null) !== expectedCid) {
    throw new PreferenceConflictError(
      "Site tag rules changed elsewhere; reload before saving",
    );
  }
  const value = existing?.value ?? {};
  if (value.$type && value.$type !== PREFERENCES_COLLECTION) {
    throw new Error("Unexpected preference record type");
  }
  const merged: UserPreferences = {
    ...DEFAULT_PREFERENCES,
    ...value,
    ...updates,
  };
  const response = await oauthSession.makeRequest(
    "POST",
    `${oauthSession.pdsUrl}/xrpc/com.atproto.repo.putRecord`,
    {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        repo: oauthSession.did,
        collection: PREFERENCES_COLLECTION,
        rkey: "self",
        swapRecord: existing?.cid ?? null,
        record: {
          ...value,
          ...merged,
          $type: PREFERENCES_COLLECTION,
          createdAt: new Date().toISOString(),
        },
      }),
    },
  );
  if (!response.ok) {
    let code: string | undefined;
    try {
      code = (await response.clone().json()).error;
    } catch { /* no error code */ }
    if (response.status === 409 || code === "InvalidSwap") {
      throw new PreferenceConflictError(
        "Preferences could not be saved; reload and try again",
      );
    }
    throw new Error("Could not save preferences to your PDS; please try again");
  }
  const result = await response.json();
  return {
    preferences: merged,
    cid: typeof result.cid === "string" ? result.cid : null,
  };
}

export async function updateUserPreferences(
  oauthSession: any,
  updates: Partial<UserPreferences>,
  expectedCid?: string | null,
): Promise<UserPreferences> {
  return (await writeUserPreferences(oauthSession, updates, expectedCid))
    .preferences;
}
