/** Bun adapter: defer native upgrade until shared security headers are complete. */
import { installResponseDefaults } from "./response-defaults.mjs";
import { createClient } from "@libsql/client";
import * as sentry from "@sentry/bun";
import { fileURLToPath } from "node:url";
import {
  installHost,
  loadApplication,
  parseEnv,
} from "../../dist/application.mjs";
import {
  indexAssets,
  installSignals,
  nativeHost,
  stopBackground,
} from "../native-common.mjs";

export async function startServer(options = {}) {
  const restoreResponse = installResponseDefaults();
  const pending = new WeakMap();
  const host = nativeHost({
    rootUrl: options.rootUrl ?? new URL("../../", import.meta.url).href,
    runtime: "bun",
    version: Bun.version,
    createDatabase: createClient,
    sentry,
    parseEnv,
    upgrade: (context, handlers) => {
      pending.set(context.req.raw, handlers);
      return Promise.resolve(new Response(null));
    },
  });
  installHost(host);
  const core = await loadApplication();
  await indexAssets(core, host);
  const handler = core.app.handler();
  const server = Bun.serve({
    hostname: options.hostname ?? process.env.HOST ?? "127.0.0.1",
    port: options.port ?? Number(process.env.PORT ?? 8000),
    async fetch(request, native) {
      const peer = native.requestIP(request);
      const response = await handler(request, {
        remoteAddr: {
          transport: "tcp",
          hostname: peer?.address,
          port: peer?.port,
        },
      });
      const hooks = pending.get(request);
      if (!hooks) return response;
      pending.delete(request);
      if (native.upgrade(request, { headers: response.headers, data: hooks })) {
        return;
      }
      throw new Error("Native Bun WebSocket upgrade failed");
    },
    websocket: {
      perMessageDeflate: false,
      open(socket) {
        socket.data.open?.(socket);
      },
      message(socket, data) {
        socket.data.message?.(socket, { data });
      },
      close(socket, code, reason) {
        socket.data.close?.(socket, code, reason);
      },
    },
  });
  let stopping;
  const stop = () =>
    stopping ??= (async () => {
      stopBackground(core);
      await server.stop();
      removeSignals();
      restoreResponse();
    })();
  const removeSignals = installSignals(stop);
  return {
    core,
    host,
    server,
    origin: `http://127.0.0.1:${server.port}`,
    stop,
  };
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { origin } = await startServer();
  console.log(`Listening on ${origin}/`);
}
