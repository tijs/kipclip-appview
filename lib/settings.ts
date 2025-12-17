/**
 * User settings database operations.
 * Stores user preferences in Turso/libSQL.
 */

import { rawDb } from "./db.ts";
import type { UserSettings } from "../shared/types.ts";

const DEFAULT_READING_LIST_TAG = "toread";

/**
 * Get user settings by DID.
 * Creates default settings if none exist.
 */
export async function getUserSettings(did: string): Promise<UserSettings> {
  // Try to get existing settings
  const result = await rawDb.execute({
    sql: "SELECT reading_list_tag FROM user_settings WHERE did = ?",
    args: [did],
  });

  if (result.rows && result.rows.length > 0) {
    const row = result.rows[0] as string[];
    return {
      readingListTag: row[0] || DEFAULT_READING_LIST_TAG,
    };
  }

  // Create default settings for new user
  await rawDb.execute({
    sql: "INSERT INTO user_settings (did, reading_list_tag) VALUES (?, ?)",
    args: [did, DEFAULT_READING_LIST_TAG],
  });

  return {
    readingListTag: DEFAULT_READING_LIST_TAG,
  };
}

/**
 * Update user settings.
 * Creates settings if they don't exist.
 */
export async function updateUserSettings(
  did: string,
  updates: Partial<UserSettings>,
): Promise<UserSettings> {
  // Validate reading list tag if provided
  if (updates.readingListTag !== undefined) {
    const tag = updates.readingListTag.trim();
    if (tag.length === 0 || tag.length > 64) {
      throw new Error("Tag must be 1-64 characters");
    }
    if (!/^[a-zA-Z0-9_-]+$/.test(tag)) {
      throw new Error(
        "Tag can only contain letters, numbers, dashes, and underscores",
      );
    }
    updates.readingListTag = tag;
  }

  // Check if settings exist
  const existing = await rawDb.execute({
    sql: "SELECT id FROM user_settings WHERE did = ?",
    args: [did],
  });

  if (existing.rows && existing.rows.length > 0) {
    // Update existing settings
    if (updates.readingListTag !== undefined) {
      await rawDb.execute({
        sql: `UPDATE user_settings
              SET reading_list_tag = ?, updated_at = CURRENT_TIMESTAMP
              WHERE did = ?`,
        args: [updates.readingListTag, did],
      });
    }
  } else {
    // Create new settings with provided values or defaults
    await rawDb.execute({
      sql: "INSERT INTO user_settings (did, reading_list_tag) VALUES (?, ?)",
      args: [did, updates.readingListTag || DEFAULT_READING_LIST_TAG],
    });
  }

  // Return updated settings
  return getUserSettings(did);
}
