/** Root asset aliases: conditional/cache-bust semantics distinct from /static. */
import { isAbsolute, join } from "@std/path";
import type { App, Middleware } from "./http-app.ts";

export interface AssetEntry {
  filePath: string;
  hash: string;
  contentType: string;
  immutable?: boolean;
}
export interface AssetSnapshot {
  root: string;
  version: string;
  files: Map<string, AssetEntry>;
  read(path: string): Promise<Uint8Array>;
}
const snapshots = new WeakMap<object, AssetSnapshot>();
export function setStaticSnapshot(
  app: App<any>,
  snapshot: AssetSnapshot,
): void {
  snapshots.set(app, snapshot);
}
export function staticFiles(app: App<any>): Middleware<any> {
  return async (ctx) => {
    const snapshot = snapshots.get(app);
    if (!snapshot) return ctx.next();
    let path: string;
    try {
      path = "/" +
        decodeURIComponent(ctx.url.pathname).split("/").filter(Boolean).map(
          encodeURIComponent,
        ).join("/");
    } catch (error) {
      if (!(error instanceof URIError)) throw error;
      return ctx.next();
    }
    const entry = snapshot.files.get(path);
    if (path === "/" || !entry) {
      if (path === "/favicon.ico") return new Response(null, { status: 404 });
      return ctx.next();
    }
    if (ctx.req.method !== "GET" && ctx.req.method !== "HEAD") {
      return new Response("Method Not Allowed", { status: 405 });
    }
    const bustKey = ctx.url.searchParams.get("__frsh_c"); // Existing URL contract.
    if (bustKey !== null && bustKey !== snapshot.version) {
      ctx.url.searchParams.delete("__frsh_c");
      return new Response(null, {
        status: 307,
        headers: { location: ctx.url.pathname + ctx.url.search },
      });
    }
    const headers = new Headers({
      "content-type": entry.contentType,
      vary: "If-None-Match",
    });
    const condition = ctx.req.headers.get("if-none-match");
    if (
      app.config.mode !== "development" &&
      (condition === entry.hash || condition === `W/"${entry.hash}"`)
    ) return new Response(null, { status: 304, headers });
    if (app.config.mode !== "development") {
      headers.set("etag", `W/"${entry.hash}"`);
    }
    headers.set(
      "cache-control",
      app.config.mode !== "development" &&
        (bustKey === snapshot.version || entry.immutable)
        ? "public, max-age=31536000, immutable"
        : "no-cache, no-store, max-age=0, must-revalidate",
    );
    const bytes = await snapshot.read(
      isAbsolute(entry.filePath)
        ? entry.filePath
        : join(snapshot.root, entry.filePath),
    );
    headers.set("content-length", String(bytes.byteLength));
    return new Response(
      ctx.req.method === "HEAD" ? null : bytes.slice().buffer,
      { headers },
    );
  };
}
