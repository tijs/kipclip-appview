/**
 * OAuth configuration and instance creation.
 * Separate from main app to avoid circular dependencies in tests.
 */

import {
  createATProtoOAuth,
  SQLiteStorage,
} from "jsr:@tijs/atproto-oauth-hono@2.3.0";
import { rawDb } from "./database/db.ts";

// Get base URL and cookie secret from environment
const BASE_URL = Deno.env.get("BASE_URL") ||
  "https://kipclip-tijs.val.town";
const COOKIE_SECRET = Deno.env.get("COOKIE_SECRET");

if (!COOKIE_SECRET) {
  throw new Error("COOKIE_SECRET environment variable is required");
}

// Create OAuth integration with SQLiteStorage
export const oauth = createATProtoOAuth({
  baseUrl: BASE_URL,
  appName: "kipclip",
  logoUri:
    "https://res.cloudinary.com/dru3aznlk/image/upload/v1760692589/kip-vignette_h2jwct.png",
  cookieSecret: COOKIE_SECRET,
  sessionTtl: 60 * 60 * 24 * 14, // 14 days in seconds (max for public clients per AT Protocol OAuth spec)
  storage: new SQLiteStorage(rawDb),
  logger: console, // Explicit logger for better debugging
});
