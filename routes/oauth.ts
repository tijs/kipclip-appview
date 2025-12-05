/**
 * OAuth routes.
 * Handles login flow and OAuth client metadata.
 */

import type { App } from "@fresh/core";
import { getBaseUrl, getOAuth } from "../lib/oauth-config.ts";

export function registerOAuthRoutes(app: App<any>): App<any> {
  // Login redirect
  app = app.get("/login", (ctx) => getOAuth().handleLogin(ctx.req));

  // OAuth callback
  app = app.get("/oauth/callback", (ctx) => getOAuth().handleCallback(ctx.req));

  // OAuth client metadata (required by AT Protocol OAuth)
  app = app.get("/oauth-client-metadata.json", () => {
    const baseUrl = getBaseUrl();
    return new Response(
      JSON.stringify({
        client_name: "kipclip",
        client_id: `${baseUrl}/oauth-client-metadata.json`,
        client_uri: baseUrl,
        redirect_uris: [`${baseUrl}/oauth/callback`],
        scope: "atproto transition:generic",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        application_type: "web",
        token_endpoint_auth_method: "none",
        dpop_bound_access_tokens: true,
        logo_uri: "https://cdn.kipclip.com/images/kip-vignette.png",
      }),
      {
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "public, max-age=3600",
        },
      },
    );
  });

  return app;
}
