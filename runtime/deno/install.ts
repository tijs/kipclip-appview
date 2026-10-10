/** Deno-only environment/filesystem/telemetry/OAuth socket capabilities. */
import { createClient } from "@libsql/client";
import { installHost } from "../host.ts";
import { load } from "@std/dotenv";
import * as sentry from "@sentry/deno";
import { upgradeDeno } from "./websocket.ts";
installHost({
  rootUrl: new URL("../../", import.meta.url).href,
  process: { runtime: "deno", version: Deno.version.deno },
  createDatabase: createClient,
  env: { get: (name) => Deno.env.get(name) },
  readTextFile: (path) => Deno.readTextFile(path),
  readFile: (path) => Deno.readFile(path),
  loadEnv: async () => {
    await load({ export: true });
  },
  upgrade: upgradeDeno,
  sentry,
});
