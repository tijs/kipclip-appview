/**
 * OAuth configuration and instance creation.
 * Supports lazy initialization to derive BASE_URL from incoming requests.
 */

import { createATProtoOAuth } from "@tijs/atproto-oauth";
import { sqliteAdapter, SQLiteStorage } from "@tijs/atproto-storage";
import { rawDb } from "./db.ts";
import { OAUTH_SCOPES } from "./route-utils.ts";

// Cookie secret is always required
const COOKIE_SECRET = Deno.env.get("COOKIE_SECRET");
if (!COOKIE_SECRET) {
  throw new Error("COOKIE_SECRET environment variable is required");
}

// OAuth instance and base URL - initialized lazily
let oauth: ReturnType<typeof createATProtoOAuth> | null = null;
let baseUrl: string | null = Deno.env.get("BASE_URL") || null;

/**
 * Get the base URL. Must be called after initOAuth().
 */
export function getBaseUrl(): string {
  if (!baseUrl) {
    throw new Error("OAuth not initialized - call initOAuth first");
  }
  return baseUrl;
}

/**
 * Initialize OAuth with the given request URL.
 * If BASE_URL env var is set, uses that. Otherwise derives from request.
 * Safe to call multiple times - only initializes once.
 */
export function initOAuth(
  requestUrl: string,
): ReturnType<typeof createATProtoOAuth> {
  if (oauth) return oauth;

  // Derive base URL from request if not set in environment
  if (!baseUrl) {
    const url = new URL(requestUrl);
    baseUrl = `${url.protocol}//${url.host}`;
    console.log(`Derived BASE_URL from request: ${baseUrl}`);
  }

  // Create OAuth integration with SQLiteStorage
  // Use "iron_session_storage" table name for backward compatibility
  oauth = createATProtoOAuth({
    baseUrl,
    appName: "kipclip",
    logoUri: "https://cdn.kipclip.com/images/kip-vignette.png",
    cookieSecret: COOKIE_SECRET,
    sessionTtl: 60 * 60 * 24 * 14, // 14 days in seconds (max for public clients per AT Protocol OAuth spec)
    scope: OAUTH_SCOPES,
    storage: new SQLiteStorage(sqliteAdapter(rawDb), {
      tableName: "iron_session_storage", // Match existing table name
      logger: console,
    }),
    logger: console,
  });

  console.log("OAuth client initialized", {
    clientId: `${baseUrl}/oauth-client-metadata.json`,
  });

  return oauth;
}

/**
 * Get the OAuth instance. Must be called after initOAuth().
 */
export function getOAuth(): ReturnType<typeof createATProtoOAuth> {
  if (!oauth) {
    throw new Error("OAuth not initialized - call initOAuth first");
  }
  return oauth;
}
