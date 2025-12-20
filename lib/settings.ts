/**
 * User settings database operations.
 * Stores user preferences in Turso/libSQL.
 */

import { rawDb } from "./db.ts";
import type { UserSettings } from "../shared/types.ts";
import { decrypt, encrypt } from "./encryption.ts";

const DEFAULT_READING_LIST_TAG = "toread";

/**
 * Get user settings by DID.
 * Creates default settings if none exist.
 */
export async function getUserSettings(did: string): Promise<UserSettings> {
  // Try to get existing settings
  const result = await rawDb.execute({
    sql: `SELECT
            reading_list_tag,
            instapaper_enabled,
            instapaper_username_encrypted
          FROM user_settings
          WHERE did = ?`,
    args: [did],
  });

  if (result.rows && result.rows.length > 0) {
    const row = result.rows[0] as (string | number | null)[];
    const readingListTag = String(row[0] || DEFAULT_READING_LIST_TAG);
    const instapaperEnabled = row[1] === 1 || row[1] === "1";
    const encryptedUsername = row[2] ? String(row[2]) : null;

    // Decrypt username if available
    let instapaperUsername: string | undefined;
    if (instapaperEnabled && encryptedUsername) {
      try {
        instapaperUsername = await decrypt(encryptedUsername);
      } catch (error) {
        console.error("Failed to decrypt Instapaper username:", error);
      }
    }

    return {
      readingListTag,
      instapaperEnabled,
      instapaperUsername,
    };
  }

  // Create default settings for new user
  await rawDb.execute({
    sql: "INSERT INTO user_settings (did, reading_list_tag) VALUES (?, ?)",
    args: [did, DEFAULT_READING_LIST_TAG],
  });

  return {
    readingListTag: DEFAULT_READING_LIST_TAG,
    instapaperEnabled: false,
  };
}

/**
 * Update user settings.
 * Creates settings if they don't exist.
 */
export async function updateUserSettings(
  did: string,
  updates: Partial<UserSettings> & { instapaperPassword?: string },
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

  // Validate Instapaper settings
  if (updates.instapaperEnabled) {
    // Check if credentials are provided or already exist
    if (!updates.instapaperUsername && !updates.instapaperPassword) {
      const existing = await rawDb.execute({
        sql: `SELECT instapaper_username_encrypted
              FROM user_settings
              WHERE did = ?`,
        args: [did],
      });

      if (!existing.rows?.[0]?.[0]) {
        throw new Error("Instapaper username and password are required");
      }
    }

    if (
      updates.instapaperUsername &&
      updates.instapaperUsername.trim().length === 0
    ) {
      throw new Error("Instapaper username cannot be empty");
    }

    if (updates.instapaperPassword && updates.instapaperPassword.length === 0) {
      throw new Error("Instapaper password cannot be empty");
    }
  }

  // Check if settings exist
  const existing = await rawDb.execute({
    sql: "SELECT id FROM user_settings WHERE did = ?",
    args: [did],
  });

  const settingsExist = existing.rows && existing.rows.length > 0;

  // Build update query dynamically
  const updateFields: string[] = [];
  const updateValues: (string | number)[] = [];

  if (updates.readingListTag !== undefined) {
    updateFields.push("reading_list_tag = ?");
    updateValues.push(updates.readingListTag);
  }

  if (updates.instapaperEnabled !== undefined) {
    updateFields.push("instapaper_enabled = ?");
    updateValues.push(updates.instapaperEnabled ? 1 : 0);
  }

  // Encrypt and update credentials if provided
  if (updates.instapaperUsername !== undefined) {
    const encrypted = await encrypt(updates.instapaperUsername.trim());
    updateFields.push("instapaper_username_encrypted = ?");
    updateValues.push(encrypted);
  }

  if (updates.instapaperPassword !== undefined) {
    const encrypted = await encrypt(updates.instapaperPassword);
    updateFields.push("instapaper_password_encrypted = ?");
    updateValues.push(encrypted);
  }

  if (settingsExist && updateFields.length > 0) {
    updateFields.push("updated_at = CURRENT_TIMESTAMP");
    updateValues.push(did); // WHERE did = ?

    await rawDb.execute({
      sql: `UPDATE user_settings
            SET ${updateFields.join(", ")}
            WHERE did = ?`,
      args: updateValues,
    });
  } else if (!settingsExist) {
    // Create new settings
    const encryptedUsername = updates.instapaperUsername
      ? await encrypt(updates.instapaperUsername.trim())
      : null;
    const encryptedPassword = updates.instapaperPassword
      ? await encrypt(updates.instapaperPassword)
      : null;

    await rawDb.execute({
      sql: `INSERT INTO user_settings
            (did, reading_list_tag, instapaper_enabled,
             instapaper_username_encrypted, instapaper_password_encrypted)
            VALUES (?, ?, ?, ?, ?)`,
      args: [
        did,
        updates.readingListTag || DEFAULT_READING_LIST_TAG,
        updates.instapaperEnabled ? 1 : 0,
        encryptedUsername,
        encryptedPassword,
      ],
    });
  }

  // Return updated settings
  return getUserSettings(did);
}
