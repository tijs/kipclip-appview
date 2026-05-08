/**
 * Live event WebSocket endpoint.
 *
 *   GET /api/live   — upgrades to a WebSocket. Authenticates via the OAuth
 *                     session cookie. Server pushes one JSON message per
 *                     mirror-applied TAP event for the authenticated DID:
 *                     `{ type, did, collection, rkey, op, indexedAt }`.
 *
 * Rules:
 *   - Unauthenticated upgrade is rejected with HTTP 401 (no upgrade).
 *   - One process holds the registry. On the Hetzner box that's a single
 *     systemd unit; on Deno Deploy this becomes per-region but we accept the
 *     degradation (Deploy is warm standby, not the live target for TAP).
 *   - Heartbeat: server emits `{type:"ping"}` every 30s. Client must reply
 *     with `{type:"pong"}`. Two consecutive missed pongs close the socket
 *     with code 1011 — the half-open detection that Caddy / browser / OS
 *     sometimes hide.
 */

import type { App } from "@fresh/core";
import { getSessionFromRequest } from "../../lib/session.ts";

export interface LiveEvent {
  type: string;
  did?: string;
  collection?: string;
  rkey?: string;
  op?: string;
  indexedAt?: number;
}

interface SocketEntry {
  did: string;
  intervalId: number;
  missedPongs: number;
}

// Sockets are held strongly by the per-DID Set in `sockets` until cleanup
// runs, so the per-socket bookkeeping uses a regular Map (not WeakMap) so
// `cleanup` can also delete the entry explicitly.
const sockets = new Map<string, Set<WebSocket>>();
const entries = new Map<WebSocket, SocketEntry>();

const HEARTBEAT_MS = 30_000;
const MAX_MISSED_PONGS = 2;

function registerSocket(did: string, socket: WebSocket): void {
  let set = sockets.get(did);
  if (!set) {
    set = new Set();
    sockets.set(did, set);
  }
  set.add(socket);
}

function unregisterSocket(did: string, socket: WebSocket): void {
  const set = sockets.get(did);
  if (!set) return;
  set.delete(socket);
  if (set.size === 0) sockets.delete(did);
}

function sendSafely(socket: WebSocket, payload: string): void {
  if (socket.readyState !== WebSocket.OPEN) return;
  try {
    socket.send(payload);
  } catch {
    // Socket may have died between the readyState check and send. Drop.
  }
}

/**
 * Cleanup is idempotent — `close` may fire after `error`, or alone, or twice
 * in pathological cases. Calling this multiple times is safe.
 */
function cleanupSocket(socket: WebSocket): void {
  const entry = entries.get(socket);
  if (!entry) return;
  clearInterval(entry.intervalId);
  entries.delete(socket);
  unregisterSocket(entry.did, socket);
}

/**
 * Push an event to every live socket for the given DID. No-op when the DID
 * has no connected sockets, so callers can fire-and-forget.
 */
export function broadcastToDid(did: string, event: LiveEvent): void {
  const set = sockets.get(did);
  if (!set || set.size === 0) return;
  const payload = JSON.stringify({ ...event, did });
  for (const ws of set) sendSafely(ws, payload);
}

/** Test hook: register a mock socket against a DID without a real upgrade. */
export function _addSocketForTest(did: string, socket: WebSocket): void {
  registerSocket(did, socket);
  // Track an entry so cleanupSocket can pop it again — mirrors what the
  // real `open` handler would do, minus the heartbeat interval.
  entries.set(socket, { did, intervalId: 0, missedPongs: 0 });
}

/** Test hook: drop everything (fixture isolation). */
export function _clearSocketsForTest(): void {
  sockets.clear();
  entries.clear();
}

/** Test hook: count sockets for a DID. */
export function _liveSocketCountForTest(did: string): number {
  return sockets.get(did)?.size ?? 0;
}

/**
 * Test hook: invoke the same cleanup path the close handler would. Lets
 * unit tests assert that the registry pops the socket and that subsequent
 * cleanup calls are idempotent.
 */
export function _cleanupSocketForTest(socket: WebSocket): void {
  cleanupSocket(socket);
}

export function registerLiveRoutes(app: App<unknown>): App<unknown> {
  app = app.get("/api/live", async (ctx) => {
    if (ctx.req.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected WebSocket upgrade", { status: 400 });
    }
    const { session } = await getSessionFromRequest(ctx.req);
    if (!session) {
      return new Response("Unauthorized", { status: 401 });
    }
    const did = session.did;
    return ctx.upgrade({
      open(socket) {
        registerSocket(did, socket);
        const intervalId = setInterval(() => {
          const entry = entries.get(socket);
          if (!entry) {
            // Cleanup ran between ticks; nothing to do (interval already
            // cleared inside cleanupSocket).
            return;
          }
          if (socket.readyState !== WebSocket.OPEN) {
            cleanupSocket(socket);
            return;
          }
          if (entry.missedPongs >= MAX_MISSED_PONGS) {
            // Clear the interval BEFORE closing so we never tick again on a
            // CLOSING socket. cleanupSocket then handles the registry pop
            // when the close event lands (or right here if it doesn't).
            cleanupSocket(socket);
            try {
              socket.close(1011, "missed pong");
            } catch {
              // Closing a socket already in CLOSING/CLOSED throws; harmless.
            }
            return;
          }
          entry.missedPongs += 1;
          sendSafely(socket, JSON.stringify({ type: "ping" }));
        }, HEARTBEAT_MS);
        entries.set(socket, { did, intervalId, missedPongs: 0 });
      },
      message(socket, ev) {
        if (typeof ev.data !== "string") return;
        try {
          const data = JSON.parse(ev.data);
          if (data?.type === "pong") {
            const entry = entries.get(socket);
            if (entry) entry.missedPongs = 0;
          }
        } catch {
          // Malformed client messages are ignored — clients only need to
          // pong; anything else is reserved for future use.
        }
      },
      close(socket) {
        cleanupSocket(socket);
      },
      error(socket, event) {
        console.warn("[live] socket error", {
          did,
          message: event instanceof ErrorEvent ? event.message : undefined,
        });
        // `error` may not be followed by `close` in every runtime; clean up
        // synchronously here to avoid leaking the socket in the registry.
        cleanupSocket(socket);
      },
    });
  });
  return app;
}
