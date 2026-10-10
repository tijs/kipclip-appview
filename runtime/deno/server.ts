/** Deno server adapter. Loopback by default; importing this never starts it. */
import "./install.ts";
import { app } from "../../main.ts";
import { getHost, loadApplication } from "../portable.ts";
import { type AssetEntry, setStaticSnapshot } from "../../lib/static-assets.ts";
import { contentType } from "@std/media-types";
import { fromFileUrl, join } from "@std/path";
import { stopPreviewEnrichmentWorker } from "../../lib/preview-enrichment-worker.ts";
import { stopLiveConnections } from "../../routes/api/live.ts";

export async function startServer(
  options: { port?: number; hostname?: string } = {},
) {
  const core = await loadApplication();
  const root = fromFileUrl(new URL("../../", import.meta.url));
  const files = new Map<string, AssetEntry>();
  async function collect(directory: string, prefix = "") {
    for await (const entry of Deno.readDir(directory)) {
      if (entry.name.startsWith(".") && entry.name !== ".well-known") continue;
      const filePath = join(directory, entry.name);
      const path = prefix + "/" + encodeURIComponent(entry.name);
      if (entry.isDirectory) await collect(filePath, path);
      else if (entry.isFile) {
        const bytes = await Deno.readFile(filePath);
        const digest = new Uint8Array(
          await crypto.subtle.digest("SHA-256", bytes),
        );
        files.set(path, {
          filePath,
          hash: [...digest].map((byte) => byte.toString(16).padStart(2, "0"))
            .join(""),
          contentType: contentType(entry.name.split(".").pop()!) ??
            "text/plain",
        });
      }
    }
  }
  await collect(join(root, "static"));
  let version = "dev";
  try {
    version =
      JSON.parse(await Deno.readTextFile(join(root, "static/manifest.json")))
        .builtAt ?? version;
  } catch { /* Development before build. */ }
  setStaticSnapshot(app, {
    root,
    version,
    files,
    read: (path) => Deno.readFile(path),
  });
  const hostname = options.hostname ?? Deno.env.get("HOST") ?? "127.0.0.1";
  const port = options.port ?? Number(Deno.env.get("PORT") ?? "8000");
  const server = Deno.serve({ hostname, port }, app.handler());
  let stopping: Promise<void> | undefined;
  const stop = () =>
    stopping ??= (async () => {
      stopPreviewEnrichmentWorker();
      stopLiveConnections();
      await server.shutdown();
      for (const signal of ["SIGINT", "SIGTERM"] as const) {
        Deno
          .removeSignalListener(signal, onSignal);
      }
    })();
  const onSignal = () => {
    stop().catch((error) => console.error("Shutdown failed", error));
  };
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    Deno.addSignalListener(signal, onSignal);
  }
  return {
    server,
    stop,
    core,
    host: getHost(),
    origin: `http://127.0.0.1:${server.addr.port}`,
  };
}
if (import.meta.main) await startServer();
