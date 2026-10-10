/** Native filesystem/lifecycle capabilities shared by the Node and Bun adapters. */
import * as fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

export function nativeHost(
  { rootUrl, runtime, version, createDatabase, sentry, upgrade, parseEnv },
) {
  return {
    rootUrl,
    process: { runtime, version },
    createDatabase,
    sentry,
    upgrade,
    env: { get: (name) => process.env[name] },
    readTextFile: (path) => fs.readFile(path, "utf8"),
    readFile: async (path) => new Uint8Array(await fs.readFile(path)),
    loadEnv: async () => {
      let text;
      try {
        text = await fs.readFile(".env", "utf8");
      } catch (error) {
        if (error.code === "ENOENT") return;
        throw error;
      }
      for (const [name, value] of Object.entries(parseEnv(text))) {
        if (!(name in process.env)) process.env[name] = value;
      }
    },
  };
}

export async function indexAssets(core, host) {
  const root = fileURLToPath(host.rootUrl);
  const files = new Map();
  async function collect(directory, prefix = "") {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      if (entry.name.startsWith(".") && entry.name !== ".well-known") continue;
      const filePath = join(directory, entry.name);
      const path = prefix + "/" + encodeURIComponent(entry.name);
      if (entry.isDirectory()) await collect(filePath, path);
      else if (entry.isFile()) {
        const bytes = await host.readFile(filePath);
        const digest = new Uint8Array(
          await crypto.subtle.digest("SHA-256", bytes),
        );
        files.set(path, {
          filePath,
          hash: [...digest].map((byte) => byte.toString(16).padStart(2, "0"))
            .join(""),
          contentType: core.contentType(entry.name.split(".").pop()) ??
            "text/plain",
        });
      }
    }
  }
  await collect(join(root, "static"));
  let version = "dev";
  try {
    version =
      JSON.parse(await host.readTextFile(join(root, "static/manifest.json")))
        .builtAt ?? version;
  } catch { /* Before frontend build. */ }
  core.assets.setStaticSnapshot(core.app, {
    root,
    files,
    version,
    read: host.readFile,
  });
}

export function stopBackground(core) {
  core.worker.stopPreviewEnrichmentWorker();
  core.live.stopLiveConnections();
}
export function installSignals(stop) {
  const signal = () => {
    stop().catch((error) => console.error("Shutdown failed", error));
  };
  process.on("SIGINT", signal);
  process.on("SIGTERM", signal);
  return () => {
    process.off("SIGINT", signal);
    process.off("SIGTERM", signal);
  };
}
