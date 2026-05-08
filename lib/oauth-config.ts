/**
 * OAuth configuration and instance creation.
 * Eagerly initialized at startup when BASE_URL env var is set; otherwise
 * lazily initialized from the first request's URL.
 */

import { createATProtoOAuth } from "@tijs/atproto-oauth";
import { sqliteAdapter, SQLiteStorage } from "@tijs/atproto-storage";
import { rawDb } from "./db.ts";
import { OAUTH_SCOPES } from "./route-utils.ts";

let oauth: ReturnType<typeof createATProtoOAuth> | null = null;
let baseUrl: string | null = null;

/**
 * Get the base URL. Must be called after initOAuth().
 */
export function getBaseUrl(): string {
  if (!baseUrl) {
    throw new Error("OAuth not initialized - call initOAuth first");
  }
  return baseUrl;
}

function buildOAuth(resolvedBaseUrl: string) {
  const COOKIE_SECRET = Deno.env.get("COOKIE_SECRET");
  if (!COOKIE_SECRET) {
    throw new Error("COOKIE_SECRET environment variable is required");
  }
  baseUrl = resolvedBaseUrl;
  // 14-day session TTL is the AT Protocol OAuth spec max for public clients.
  // "iron_session_storage" table name retained for backward compatibility.
  oauth = createATProtoOAuth({
    baseUrl,
    appName: "kipclip",
    logoUri: "https://cdn.kipclip.com/images/kip-vignette.png",
    cookieSecret: COOKIE_SECRET,
    sessionTtl: 60 * 60 * 24 * 14,
    scope: OAUTH_SCOPES,
    storage: new SQLiteStorage(sqliteAdapter(rawDb), {
      tableName: "iron_session_storage",
    }),
  });
  console.log("OAuth client initialized", {
    clientId: `${baseUrl}/oauth-client-metadata.json`,
  });
  return oauth;
}

/**
 * Eager init: only succeeds when the BASE_URL env var is set. Returns true
 * when OAuth is now ready, false when BASE_URL is unset and the caller must
 * fall back to per-request lazy init via `initOAuth(ctx.url)`.
 */
export function tryInitOAuthFromEnv(): boolean {
  if (oauth) return true;
  const envBaseUrl = Deno.env.get("BASE_URL");
  if (!envBaseUrl) return false;
  console.log(`Using BASE_URL from environment: ${envBaseUrl}`);
  buildOAuth(envBaseUrl);
  return true;
}

/**
 * Lazy init from a request URL. Pass `ctx.url` from a Fresh handler — when
 * `trustProxy` is on the App, Fresh has already applied
 * X-Forwarded-Proto/X-Forwarded-Host so the URL reflects the public scheme
 * and host. Safe to call multiple times — only initializes once.
 */
export function initOAuth(
  url: URL,
): ReturnType<typeof createATProtoOAuth> {
  if (oauth) return oauth;
  const envBaseUrl = Deno.env.get("BASE_URL");
  if (envBaseUrl) {
    console.log(`Using BASE_URL from environment: ${envBaseUrl}`);
    return buildOAuth(envBaseUrl);
  }
  const derived = `${url.protocol.replace(":", "")}://${url.host}`;
  console.log(`Derived BASE_URL from request: ${derived}`);
  return buildOAuth(derived);
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
