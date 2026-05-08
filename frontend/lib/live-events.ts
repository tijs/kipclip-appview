/**
 * Server → SPA push channel.
 *
 * Connects to `/api/live` over WebSocket once a session is known. The server
 * pushes one JSON message per mirror-applied TAP event for the authenticated
 * DID. Events arriving within a 100ms window are coalesced into a single
 * `onEvents` callback so a bulk-tag write doesn't trigger N renders.
 *
 * Reconnects with 1s → 30s exponential backoff. Closes when the document is
 * hidden and re-opens on `visibilitychange`. Replies to server pings with
 * `{type:"pong"}` so the server can drop half-open sockets.
 *
 * Falls back gracefully when the WebSocket cannot connect — `onStateChange`
 * fires with `"closed"` and reconnect attempts back off; existing
 * AppContext flows continue to work without live updates.
 */

export interface LiveEvent {
  type: string;
  did?: string;
  collection?: string;
  rkey?: string;
  op?: string;
  indexedAt?: number;
}

export type LiveConnectionState = "connecting" | "open" | "closed";

export interface LiveConnectionOptions {
  onEvents: (events: LiveEvent[]) => void;
  onStateChange?: (state: LiveConnectionState) => void;
  /** Override for tests; defaults to wss?://<location.host>/api/live. */
  url?: string;
}

export interface LiveConnection {
  close(): void;
}

const COALESCE_WINDOW_MS = 100;
const INITIAL_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30_000;
// A bulk-tag write of N records produces N events within ~100ms. Cap the
// coalescing buffer so a backgrounded tab (where setTimeout is throttled)
// can't grow it without bound; on overflow we force-flush synchronously so
// the AppContext refetch fires regardless.
const MAX_BUFFERED_EVENTS = 500;

function deriveLiveUrl(): string {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}/api/live`;
}

export function connectLiveEvents(
  opts: LiveConnectionOptions,
): LiveConnection {
  const url = opts.url ?? deriveLiveUrl();

  let socket: WebSocket | null = null;
  let stopped = false;
  let backoffMs = INITIAL_BACKOFF_MS;
  let reconnectTimer: number | null = null;
  let coalesceBuf: LiveEvent[] = [];
  let coalesceTimer: number | null = null;
  // Flips true while we are explicitly closing the socket because the tab
  // went hidden. Stays true through the ensuing `close` event so we know
  // not to schedule a server-driven reconnect, and through the next
  // `visibilitychange` so the reopen knows to reset backoff. Cleared once
  // we either (a) successfully reopen on visibility, or (b) the close
  // event has been handled.
  let closedByVisibility = false;
  // Tracks whether the last close was triggered by an actual server/network
  // event (vs. a clean visibility-driven close). When true, a subsequent
  // visibility-driven reopen MUST NOT reset backoff — we'd otherwise hammer
  // a dead server every 1s on each tab refocus during an outage.
  let lastCloseWasServerDriven = false;

  function flushCoalesced() {
    coalesceTimer = null;
    if (coalesceBuf.length === 0) return;
    const batch = coalesceBuf;
    coalesceBuf = [];
    try {
      opts.onEvents(batch);
    } catch (err) {
      console.error("[live] onEvents handler threw", err);
    }
  }

  function scheduleEvent(ev: LiveEvent) {
    coalesceBuf.push(ev);
    if (coalesceBuf.length >= MAX_BUFFERED_EVENTS) {
      // Overflow — flush right now rather than waiting for the timer
      // (which may be throttled in a backgrounded tab).
      if (coalesceTimer !== null) {
        globalThis.clearTimeout(coalesceTimer);
        coalesceTimer = null;
      }
      flushCoalesced();
      return;
    }
    if (coalesceTimer === null) {
      coalesceTimer = globalThis.setTimeout(flushCoalesced, COALESCE_WINDOW_MS);
    }
  }

  function clearReconnect() {
    if (reconnectTimer !== null) {
      globalThis.clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  }

  function scheduleReconnect() {
    if (stopped) return;
    clearReconnect();
    const delay = backoffMs;
    backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
    reconnectTimer = globalThis.setTimeout(() => {
      if (!stopped) openSocket();
    }, delay);
  }

  function openSocket() {
    if (stopped) return;
    if (typeof document !== "undefined" && document.hidden) return;
    opts.onStateChange?.("connecting");
    let next: WebSocket;
    try {
      next = new WebSocket(url);
    } catch (err) {
      console.error("[live] WebSocket constructor threw", err);
      opts.onStateChange?.("closed");
      scheduleReconnect();
      return;
    }
    socket = next;
    next.onopen = () => {
      backoffMs = INITIAL_BACKOFF_MS;
      lastCloseWasServerDriven = false;
      opts.onStateChange?.("open");
    };
    next.onmessage = (ev) => {
      if (typeof ev.data !== "string") return;
      let data: unknown;
      try {
        data = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (typeof data !== "object" || data === null) return;
      const obj = data as Record<string, unknown>;
      if (obj.type === "ping") {
        try {
          next.send(JSON.stringify({ type: "pong" }));
        } catch {
          // Socket may have transitioned to CLOSING between the read and
          // the send; the close handler will reconnect.
        }
        return;
      }
      if (typeof obj.type === "string") {
        scheduleEvent(obj as unknown as LiveEvent);
      }
    };
    next.onclose = () => {
      opts.onStateChange?.("closed");
      if (socket === next) socket = null;
      if (closedByVisibility) {
        // Clean close — the next reopen happens on `visible` and resets
        // backoff there.
        closedByVisibility = false;
      } else {
        // Server-driven close (network outage, server restart, idle
        // timeout). Keep the existing backoff schedule. If the tab is
        // currently visible, schedule the next reconnect now; if hidden,
        // skip — visibility handler will reopen on focus and the open
        // path will keep the existing backoff because
        // lastCloseWasServerDriven is true.
        lastCloseWasServerDriven = true;
        if (typeof document === "undefined" || !document.hidden) {
          scheduleReconnect();
        }
      }
    };
    next.onerror = (ev) => {
      console.warn("[live] socket error", ev);
      // Browser fires `close` right after `error`; reconnection happens there.
    };
  }

  let visibilityHandler: (() => void) | null = null;
  if (typeof document !== "undefined") {
    visibilityHandler = () => {
      if (document.hidden) {
        clearReconnect();
        if (socket !== null) {
          closedByVisibility = true;
          try {
            socket.close();
          } catch {
            // Already closing/closed.
          }
          socket = null;
        }
      } else if (!socket) {
        // Reopen on visibility. Reset backoff ONLY if the last close was a
        // clean visibility-driven close — if the server was unreachable
        // when we lost focus, keep the backoff schedule so we don't
        // hammer the dead server every 1s on each refocus.
        if (!lastCloseWasServerDriven) backoffMs = INITIAL_BACKOFF_MS;
        openSocket();
      }
    };
    document.addEventListener("visibilitychange", visibilityHandler);
  }

  openSocket();

  return {
    close() {
      stopped = true;
      clearReconnect();
      if (coalesceTimer !== null) {
        globalThis.clearTimeout(coalesceTimer);
        coalesceTimer = null;
      }
      if (
        visibilityHandler !== null && typeof document !== "undefined"
      ) {
        document.removeEventListener("visibilitychange", visibilityHandler);
      }
      try {
        socket?.close();
      } catch {
        // Already closing/closed.
      }
      socket = null;
    },
  };
}
