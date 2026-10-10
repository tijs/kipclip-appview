/** Deno adapter exercise with a real loopback HTTP/WebSocket transport. */
import { assertEquals } from "@std/assert";
import { app } from "../../main.ts";
import { _liveSocketCountForTest } from "../../routes/api/live.ts";

// Keep the wire client's Node ambient types out of the Deno application's
// compilation unit. This already-cached transitive dependency is test-only.
const wsSpecifier = "ws";
const { default: Client } = await import(wsSpecifier);

export interface WireClient {
  socket: any;
  messages: any[];
  handshake: { status: number; headers: Record<string, any> };
  closed: Promise<{ code: number; reason: string }>;
  nextMessage(): Promise<any>;
}

function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: number;
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error("Loopback WebSocket timed out")),
        3000,
      );
    }),
  ]).finally(() => clearTimeout(timer));
}

export async function withLiveServer(
  run: (fixture: {
    origin: string;
    connect(cookie?: string): Promise<WireClient>;
    tick(): void;
    intervals: Map<number, () => void>;
  }) => Promise<void>,
): Promise<void> {
  const originalInterval = globalThis.setInterval;
  const originalClear = globalThis.clearInterval;
  const intervals = new Map<number, () => void>();
  const ownedSockets: any[] = [];
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    app.handler(),
  );
  let id = -100;
  // Advance the ACTUAL route's 30s callback deterministically; network I/O is
  // real and normal timeouts remain real. No heartbeat constants are modified.
  globalThis.setInterval =
    ((callback: () => void, delay?: number, ...args: any[]) => {
      if (delay !== 30_000) return originalInterval(callback, delay, ...args);
      intervals.set(--id, callback);
      return id;
    }) as typeof setInterval;
  globalThis.clearInterval = ((timer?: number) => {
    if (timer !== undefined && intervals.delete(timer)) return;
    originalClear(timer);
  }) as typeof clearInterval;
  const clients: WireClient[] = [];
  const origin = `http://127.0.0.1:${server.addr.port}`;
  try {
    await run({
      origin,
      intervals,
      tick() {
        for (const callback of [...intervals.values()]) callback();
      },
      async connect(cookie) {
        const socket = new Client(
          origin.replace("http:", "ws:") + "/api/live",
          { headers: cookie ? { cookie } : {} },
        );
        ownedSockets.push(socket);
        const messages: any[] = [];
        const pending: ((message: any) => void)[] = [];
        const queued: any[] = [];
        let handshake: WireClient["handshake"];
        socket.on("upgrade", (res) => {
          handshake = { status: res.statusCode!, headers: res.headers };
        });
        socket.on("message", (bytes) => {
          const message = JSON.parse(bytes.toString());
          messages.push(message);
          const resolve = pending.shift();
          if (resolve) resolve(message);
          else queued.push(message);
        });
        const closed = new Promise<{ code: number; reason: string }>((
          resolve,
        ) =>
          socket.once(
            "close",
            (code, reason) => resolve({ code, reason: reason.toString() }),
          )
        );
        await bounded(
          new Promise<void>((resolve, reject) => {
            socket.once("open", () => resolve());
            socket.once("error", reject);
            socket.once("unexpected-response", (_req, res) => {
              res.resume();
              reject(new Error(`Unexpected upgrade status ${res.statusCode}`));
            });
          }),
        );
        const client: WireClient = {
          socket,
          messages,
          handshake: handshake!,
          closed,
          nextMessage() {
            if (queued.length) return Promise.resolve(queued.shift());
            return bounded(new Promise((resolve) => pending.push(resolve)));
          },
        };
        clients.push(client);
        return client;
      },
    });
  } finally {
    try {
      for (const client of clients) {
        if (client.socket.readyState === Client.OPEN) client.socket.close(1000);
      }
      await Promise.all(clients.map((client) => bounded(client.closed)));
    } finally {
      // Failed handshakes must also release their owned client transport.
      for (const socket of ownedSockets) {
        if (socket.readyState !== Client.CLOSED) socket.terminate();
      }
      try {
        await server.shutdown();
      } finally {
        globalThis.setInterval = originalInterval;
        globalThis.clearInterval = originalClear;
      }
    }
    assertEquals(
      intervals.size,
      0,
      "Actual close handler must clear heartbeat intervals",
    );
  }
}

export function countSockets(did: string): number {
  return _liveSocketCountForTest(did);
}

/**
 * Flush wire messages by using a server ping as an ordered barrier. This is
 * stronger than sleeping and assuming that a prohibited event never arrived.
 */
export async function barrier(
  client: WireClient,
  tick: () => void,
): Promise<void> {
  tick();
  assertEquals(await client.nextMessage(), { type: "ping" });
}
