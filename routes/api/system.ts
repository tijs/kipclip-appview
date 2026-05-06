/**
 * System API routes for release observability.
 *
 *   GET  /api/version     -- returns the running release tag (and only
 *                            the tag — sha + builtAt were dropped in
 *                            the security hardening pass, since they
 *                            give an attacker exploit-kit precision
 *                            without aiding any non-operator caller.
 *                            The full manifest is still on disk at
 *                            static/manifest.json for operators with
 *                            shell access.
 *   GET  /api/health      -- liveness probe. Returns 200 with the same
 *                            version string so monitors can verify both
 *                            up-ness and which release is up.
 *   POST /api/csp-report  -- receives Content-Security-Policy violation
 *                            reports. Logs to stderr (Sentry-aggregated).
 *                            Browsers POST application/csp-report or
 *                            application/reports+json depending on the
 *                            directive; both are body-text-logged as-is.
 *
 * GET endpoints are unauthenticated and expose no PII -- only the
 * release tag. Manifest is read once at module load and cached for the
 * lifetime of the process; restart picks up new release metadata
 * (intended -- the deno serve process is restarted on every release
 * swap by the kipclip-release timer).
 */

import type { App } from "@fresh/core";

interface VersionInfo {
  version: string;
  sha: string;
  builtAt: string;
}

const FALLBACK: VersionInfo = {
  version: "unknown",
  sha: "unknown",
  builtAt: "unknown",
};

async function loadVersionInfo(): Promise<VersionInfo> {
  // KIPCLIP_MANIFEST_PATH lets tests point at a fixture without clobbering
  // static/manifest.json, and gives operators an explicit knob if the
  // systemd WorkingDirectory contract ever changes. Falls back to CWD-
  // relative "static/manifest.json": systemd sets WorkingDirectory to the
  // release dir (/var/lib/kipclip/current) and `deno task dev` runs from
  // the repo root, so the fallback resolves correctly in both.
  const path = Deno.env.get("KIPCLIP_MANIFEST_PATH") ?? "static/manifest.json";
  try {
    const manifestContent = await Deno.readTextFile(path);
    const manifest = JSON.parse(manifestContent);
    return {
      version: typeof manifest.version === "string"
        ? manifest.version
        : FALLBACK.version,
      sha: typeof manifest.sha === "string" ? manifest.sha : FALLBACK.sha,
      builtAt: typeof manifest.builtAt === "string"
        ? manifest.builtAt
        : (typeof manifest.buildTime === "string"
          ? manifest.buildTime
          : FALLBACK.builtAt),
    };
  } catch (err) {
    // Surface the failure so silent FALLBACK ("unknown") doesn't go
    // unnoticed in journalctl/Sentry — the v0.10.1 manifest-path bug
    // shipped because nothing logged this catch.
    console.warn(`[system] loadVersionInfo failed for ${path}:`, err);
    return FALLBACK;
  }
}

// Cached at module load. Process restart on release swap rotates this.
const versionInfoPromise = loadVersionInfo();

export function registerSystemRoutes(app: App<unknown>): App<unknown> {
  app = app.get("/api/version", async () => {
    const info = await versionInfoPromise;
    // Public response is version-only. sha and builtAt remain in the
    // internal VersionInfo (and on disk in static/manifest.json) for
    // operators with shell access.
    return Response.json({ version: info.version });
  });

  app = app.get("/api/health", async () => {
    const info = await versionInfoPromise;
    return Response.json({ ok: true, version: info.version });
  });

  // CSP violation report sink. Endpoint exists ahead of CSP enforcement
  // (security plan U5) so the policy can ship with `report-to` pointing
  // here on day one — Report-Only without a sink is per-session console
  // noise that monitoring can't see (doc-review SEC-005). Logs raw body
  // to stderr; production journalctl/Sentry aggregate from there.
  app = app.post("/api/csp-report", async (ctx) => {
    try {
      const body = await ctx.req.text();
      // Body is small JSON (<2KB typical). Truncate at 4KB defensively
      // so a hostile or buggy reporter can't pin our log buffer.
      const truncated = body.length > 4096
        ? body.slice(0, 4096) + "...[truncated]"
        : body;
      console.warn("[csp-report]", truncated);
    } catch (err) {
      console.error("[csp-report] body read error", err);
    }
    // 204: browsers don't act on the response, so no body needed.
    return new Response(null, { status: 204 });
  });

  return app;
}
