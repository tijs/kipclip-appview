/** Deno host boundary; shared routes never upgrade sockets themselves. */
import { upgradeWebSocket } from "@hono/hono/deno";
import type { Upgrade } from "../../lib/http-app.ts";

export const upgradeDeno: Upgrade = (context, handlers) => {
  const middleware = upgradeWebSocket(() => ({
    onOpen: (_event, ws) => handlers.open?.(ws.raw!),
    onMessage: (event, ws) => handlers.message?.(ws.raw!, event),
    onClose: (event, ws) => handlers.close?.(ws.raw!, event.code, event.reason),
    onError: (event, ws) => handlers.error?.(ws.raw!, event),
  }), { protocol: undefined }); // No implicit subprotocol selection in baseline.
  // Header tokens are case-insensitive; normalize for the adapter, not for the
  // domain's raw Request. Its Request/cookie/URL identity remains unchanged.
  const adapterContext = Object.create(context);
  Object.defineProperty(adapterContext, "req", {
    value: {
      raw: context.req.raw,
      header: (name: string) =>
        name === "upgrade"
          ? context.req.header(name)?.toLowerCase()
          : context.req.header(name),
    },
  });
  return middleware(adapterContext, async () => {}) as Promise<Response>;
};
