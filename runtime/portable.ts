/** Bundle boundary: host is installed BEFORE deferred application evaluation. */
export { parse as parseEnv } from "@std/dotenv";
export { getHost, installHost } from "./host.ts";
export async function loadApplication() {
  const { app } = await import("../main.ts");
  const { db } = await import("../lib/db.ts");
  const live = await import("../routes/api/live.ts");
  const worker = await import("../lib/preview-enrichment-worker.ts");
  const assets = await import("../lib/static-assets.ts");
  const { SessionManager } = await import("@tijs/atproto-sessions");
  const { OAuthClient } = await import("@tijs/oauth-client-deno");
  const { encodeTagsForUrl } = await import("../shared/utils.ts");
  const { processEvent } = await import("../worker/webhook.ts");
  const { contentType } = await import("@std/media-types");
  return {
    app,
    db,
    live,
    worker,
    assets,
    SessionManager,
    OAuthClient,
    encodeTagsForUrl,
    processEvent,
    contentType,
  };
}
