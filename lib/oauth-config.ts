/**
 * OAuth configuration and instance creation.
 * Separate from main app to avoid circular dependencies in tests.
 */

import { createATProtoOAuth } from "jsr:@tijs/atproto-oauth@2.1.0";
import { sqliteAdapter, SQLiteStorage } from "jsr:@tijs/atproto-storage@1.0.0";
import { rawDb } from "./db.ts";

// Get base URL and cookie secret from environment
const BASE_URL = Deno.env.get("BASE_URL");
const COOKIE_SECRET = Deno.env.get("COOKIE_SECRET");

if (!BASE_URL) {
  throw new Error("BASE_URL environment variable is required");
}
if (!COOKIE_SECRET) {
  throw new Error("COOKIE_SECRET environment variable is required");
}

// Create OAuth integration with SQLiteStorage
// Use "iron_session_storage" table name for backward compatibility
export const oauth = createATProtoOAuth({
  baseUrl: BASE_URL,
  appName: "kipclip",
  logoUri: "https://cdn.kipclip.com/images/kip-vignette.png",
  cookieSecret: COOKIE_SECRET,
  sessionTtl: 60 * 60 * 24 * 14, // 14 days in seconds (max for public clients per AT Protocol OAuth spec)
  storage: new SQLiteStorage(sqliteAdapter(rawDb), {
    tableName: "iron_session_storage", // Match existing table name
    logger: console,
  }),
  logger: console, // Explicit logger for better debugging
});
