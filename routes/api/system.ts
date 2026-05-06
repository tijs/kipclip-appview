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
import { readFile } from "../../lib/file-server.ts";

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
  try {
    const manifestContent = await readFile(
      "/static/manifest.json",
      import.meta.url,
    );
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
  } catch {
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
