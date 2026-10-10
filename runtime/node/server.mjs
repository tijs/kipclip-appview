/** Node adapter: standard HTTP, deferred authenticated WS upgrade, owned stop. */
import { serve } from "@hono/node-server";
import { WebSocketServer } from "ws";
import { createClient } from "@libsql/client";
import * as sentry from "@sentry/node";
import { fileURLToPath } from "node:url";
import { STATUS_CODES } from "node:http";
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
  const pending = new WeakMap();
  const host = nativeHost({
    rootUrl: options.rootUrl ?? new URL("../../", import.meta.url).href,
    runtime: "node",
    version: process.versions.node,
    createDatabase: createClient,
    sentry,
    parseEnv,
    upgrade: (context, handlers) => {
      pending.set(context.req.raw, handlers);
      return Promise.resolve(new Response(null)); // Handshake occurs after response/security unwinding.
    },
  });
  installHost(host);
  const core = await loadApplication();
  await indexAssets(core, host);
  const handler = core.app.handler();
  const server = serve({
    overrideGlobalObjects: false,
    hostname: options.hostname ?? process.env.HOST ?? "127.0.0.1",
    port: options.port ?? Number(process.env.PORT ?? 8000),
    fetch: (request, env) =>
      handler(request, {
        remoteAddr: {
          transport: "tcp",
          hostname: env.incoming.socket.remoteAddress,
          port: env.incoming.socket.remotePort,
        },
      }),
  });
  await new Promise((resolve, reject) => {
    if (server.listening) resolve();
    else {
      server.once("listening", resolve);
      server.once("error", reject);
    }
  });
  const responseHeaders = new WeakMap();
  const wss = new WebSocketServer({
    noServer: true,
    handleProtocols: () => false,
    perMessageDeflate: false,
  });
  wss.on("headers", (headers, incoming) => {
    for (const [name, value] of responseHeaders.get(incoming) ?? []) {
      headers.push(`${name}: ${value}`);
    }
  });
  server.on("upgrade", async (incoming, socket, head) => {
    socket.on("error", () => {}); // Failed handshakes must not crash the host.
    try {
      const headers = new Headers();
      for (let i = 0; i < incoming.rawHeaders.length; i += 2) {
        headers.append(incoming.rawHeaders[i], incoming.rawHeaders[i + 1]);
      }
      const request = new Request(
        `http://${headers.get("host")}${incoming.url}`,
        { method: incoming.method, headers },
      );
      const response = await handler(request, {
        remoteAddr: {
          transport: "tcp",
          hostname: socket.remoteAddress,
          port: socket.remotePort,
        },
      });
      const hooks = pending.get(request);
      if (!hooks) {
        const bytes = new Uint8Array(await response.arrayBuffer());
        const statusLine = `HTTP/1.1 ${response.status} ${
          response.statusText || STATUS_CODES[response.status] || "Rejected"
        }\r\n`;
        socket.end(
          statusLine + [...response.headers].map(([name, value]) =>
            `${name}: ${value}\r\n`
          ).join("") +
            `Content-Length: ${bytes.length}\r\nConnection: close\r\n\r\n` +
            new TextDecoder().decode(bytes),
        );
        return;
      }
      pending.delete(request);
      responseHeaders.set(incoming, response.headers);
      wss.handleUpgrade(incoming, socket, head, (ws) => {
        ws.on(
          "message",
          (bytes, binary) =>
            hooks.message?.(ws, { data: binary ? bytes : bytes.toString() }),
        );
        ws.on(
          "close",
          (code, reason) => hooks.close?.(ws, code, reason.toString()),
        );
        ws.on(
          "error",
          (error) => hooks.error?.(ws, { message: error.message }),
        );
        hooks.open?.(ws);
      });
    } catch (error) {
      console.error("Upgrade failed", error);
      socket.end(
        "HTTP/1.1 500 Internal Server Error\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
      );
    }
  });
  let stopping;
  const stop = () =>
    stopping ??= (async () => {
      stopBackground(core);
      await new Promise((resolve, reject) =>
        server.close((error) => error ? reject(error) : resolve())
      );
      await new Promise((resolve) => wss.close(resolve));
      removeSignals();
    })();
  const removeSignals = installSignals(stop);
  const origin = `http://127.0.0.1:${server.address().port}`;
  return { core, host, origin, stop, server };
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { origin } = await startServer();
  console.log(`Listening on ${origin}/`);
}
