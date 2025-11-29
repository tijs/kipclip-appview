/**
 * OAuth configuration and instance creation.
 * Separate from main app to avoid circular dependencies in tests.
 */

import { createATProtoOAuth } from "jsr:@tijs/atproto-oauth@2.0.0";
import { SQLiteStorage, valTownAdapter } from "jsr:@tijs/atproto-storage@0.1.1";
import { rawDb } from "./database/db.ts";

// Get base URL and cookie secret from environment
const BASE_URL = Deno.env.get("BASE_URL") ||
  "https://kipclip-tijs.val.town";
const COOKIE_SECRET = Deno.env.get("COOKIE_SECRET");

if (!COOKIE_SECRET) {
  throw new Error("COOKIE_SECRET environment variable is required");
}

// Create OAuth integration with SQLiteStorage
// Use "iron_session_storage" table name for backward compatibility
export const oauth = createATProtoOAuth({
  baseUrl: BASE_URL,
  appName: "kipclip",
  logoUri:
    "https://res.cloudinary.com/dru3aznlk/image/upload/v1760692589/kip-vignette_h2jwct.png",
  cookieSecret: COOKIE_SECRET,
  sessionTtl: 60 * 60 * 24 * 14, // 14 days in seconds (max for public clients per AT Protocol OAuth spec)
  storage: new SQLiteStorage(valTownAdapter(rawDb), {
    tableName: "iron_session_storage", // Match existing table name
    logger: console,
  }),
  logger: console, // Explicit logger for better debugging
});
