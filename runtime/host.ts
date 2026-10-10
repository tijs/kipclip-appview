/** Narrow host capabilities. Install an adapter before importing the app. */
import type { Upgrade } from "../lib/http-app.ts";
export interface Host {
  env: { get(name: string): string | undefined };
  rootUrl: string;
  process: { runtime: "deno" | "bun" | "node"; version: string };
  createDatabase(options: { url: string }): any;
  readTextFile(path: string): Promise<string>;
  readFile(path: string): Promise<Uint8Array<ArrayBuffer>>;
  loadEnv(): Promise<void>;
  upgrade: Upgrade;
  sentry: any;
}
let host: Host | undefined;
export function installHost(adapter: Host): void {
  host = adapter;
}
export function getHost(): Host {
  if (!host) {
    throw new Error(
      "Install a runtime adapter before importing application modules",
    );
  }
  return host;
}
