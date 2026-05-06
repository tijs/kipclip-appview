/**
 * System API routes for release observability.
 *
 *   GET /api/version  -- returns the running release tag, sha, and build
 *                        timestamp baked into static/manifest.json by
 *                        scripts/build-frontend.ts at release time.
 *   GET /api/health   -- liveness probe. Returns 200 with the same version
 *                        string so monitors can verify both up-ness and
 *                        which release is up.
 *
 * Both endpoints are unauthenticated GETs. Neither exposes PII -- only
 * release metadata. Manifest is read once at module load and cached for
 * the lifetime of the process; restart picks up new release metadata
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
    return Response.json(info);
  });

  app = app.get("/api/health", async () => {
    const info = await versionInfoPromise;
    return Response.json({ ok: true, version: info.version });
  });

  return app;
}
