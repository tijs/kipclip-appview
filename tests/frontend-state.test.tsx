import React from "react";
import Renderer, { act } from "npm:react-test-renderer@19.2.3";
import { assert, assertEquals, assertRejects } from "@std/assert";
import { AppProvider, useApp } from "../frontend/context/AppContext.tsx";
import { connectLiveEvents } from "../frontend/lib/live-events.ts";
import type { EnrichedBookmark } from "../shared/types.ts";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const prefs = { dateFormat: "us", readingListTag: "toread" };
const bookmark = (name: string): EnrichedBookmark => ({
  uri: `at://did:plc:test/community.lexicon.bookmarks.bookmark/${name}`,
  cid: name,
  subject: `https://${name}.test`,
  createdAt: "2026-01-01T00:00:00Z",
  tags: [],
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => resolve = r);
  return { promise, resolve };
}
class Socket {
  static sockets: Socket[] = [];
  onopen: any;
  onmessage: any;
  onclose: any;
  onerror: any;
  constructor(_url: string) {
    Socket.sockets.push(this);
  }
  send() {}
  close() {}
  event(collection: string) {
    this.onmessage?.({ data: JSON.stringify({ type: "record", collection }) });
  }
}
class Doc extends EventTarget {
  hidden = false;
  visibilityState = "visible";
}
async function mount(
  fetcher: (url: string, init?: RequestInit) => Promise<Response>,
) {
  const keys = ["document", "location", "WebSocket", "fetch"] as const;
  const saved = keys.map((k) => Object.getOwnPropertyDescriptor(globalThis, k));
  const doc = new Doc();
  Socket.sockets = [];
  Object.defineProperty(globalThis, "document", {
    value: doc,
    configurable: true,
  });
  Object.defineProperty(globalThis, "location", {
    value: {
      search: "",
      protocol: "http:",
      host: "localhost",
      origin: "http://localhost",
    },
    configurable: true,
  });
  Object.defineProperty(globalThis, "WebSocket", {
    value: Socket,
    configurable: true,
  });
  globalThis.fetch =
    ((url: any, init?: RequestInit) =>
      fetcher(String(url), init)) as typeof fetch;
  let api!: ReturnType<typeof useApp>, root: any;
  function Probe() {
    api = useApp();
    return null;
  }
  await act(() => {
    root = Renderer.create(
      React.createElement(AppProvider, {}, React.createElement(Probe)),
    );
  });
  return {
    get api() {
      return api;
    },
    root,
    doc,
    async close() {
      await act(() => root.unmount());
      keys.forEach((k, i) => {
        if (saved[i]) Object.defineProperty(globalThis, k, saved[i]!);
        else delete (globalThis as any)[k];
      });
    },
  };
}
const initial = (bookmarks: EnrichedBookmark[] = []) =>
  Response.json({
    bookmarks,
    preferences: prefs,
    settings: { instapaperEnabled: false },
    isSupporter: false,
  });
const tick = () => new Promise((r) => setTimeout(r, 120));

Deno.test("provider refresh callers wait for a trailing snapshot and new state", async () => {
  const first = deferred<Response>(), second = deferred<Response>();
  let loads = 0;
  const view = await mount((url) =>
    url.startsWith("/api/initial-data")
      ? (++loads === 1 ? first.promise : second.promise)
      : Promise.resolve(Response.json({ tags: [] }))
  );
  try {
    let a!: Promise<void>, b!: Promise<void>;
    let bDone = false;
    await act(() => {
      a = view.api.loadInitialData();
    });
    await act(() => {
      b = view.api.refreshData().then(() => {
        bDone = true;
      });
    });
    assertEquals(loads, 1);
    assertEquals(bDone, false);
    await act(async () => {
      first.resolve(initial([bookmark("old")]));
      await Promise.resolve();
    });
    assertEquals(loads, 2);
    assertEquals(bDone, false);
    await act(async () => {
      second.resolve(initial([bookmark("new")]));
      await Promise.all([a, b]);
    });
    assertEquals(view.api.bookmarks.map((b) => b.cid), ["new"]);
    assertEquals(bDone, true);
  } finally {
    await view.close();
  }
});

Deno.test("live invalidations during a deferred response run again; reconnect catches up", async () => {
  const first = deferred<Response>();
  let slices = 0, full = 0;
  const view = await mount((url) => {
    if (url === "/api/bookmarks") {
      return ++slices === 1
        ? first.promise
        : Promise.resolve(Response.json({ bookmarks: [bookmark("latest")] }));
    }
    if (url.startsWith("/api/initial-data")) {
      full++;
      return Promise.resolve(initial([bookmark("reconnected")]));
    }
    return Promise.resolve(Response.json({ tags: [] }));
  });
  try {
    await act(() =>
      view.api.setSession({ did: "did:plc:test", handle: "test" })
    );
    const socket = Socket.sockets[0];
    await act(() => socket.onopen());
    await act(async () => {
      socket.event("com.kipclip.annotation");
      await tick();
    });
    await act(async () => {
      socket.event("com.kipclip.annotation");
      await tick();
    });
    assertEquals(slices, 1);
    await act(async () => {
      first.resolve(Response.json({ bookmarks: [bookmark("old")] }));
      await tick();
    });
    assertEquals(slices, 2);
    assertEquals(view.api.bookmarks[0].cid, "latest");
    await act(() => {
      view.doc.hidden = true;
      view.doc.dispatchEvent(new Event("visibilitychange"));
    });
    await act(() => {
      view.doc.hidden = false;
      view.doc.dispatchEvent(new Event("visibilitychange"));
    });
    const reopened = Socket.sockets[1];
    await act(async () => {
      reopened.onopen();
      await tick();
    });
    assertEquals(full, 1);
    assertEquals(view.api.bookmarks[0].cid, "reconnected");
  } finally {
    await view.close();
  }
});

Deno.test("logout clears data and fences old account responses", async () => {
  const old = deferred<Response>();
  const view = await mount((url) =>
    url === "/api/bookmarks"
      ? old.promise
      : Promise.resolve(Response.json({ tags: [] }))
  );
  try {
    await act(() => {
      view.api.setSession({ did: "did:plc:test", handle: "old" });
      view.api.addBookmark(bookmark("cached"));
    });
    let pending!: Promise<void>;
    await act(() => {
      pending = view.api.loadBookmarks();
    });
    await act(() => view.api.setSession(null));
    assertEquals(view.api.bookmarks, []);
    await act(async () => {
      old.resolve(Response.json({ bookmarks: [bookmark("private")] }));
      await pending;
    });
    assertEquals(view.api.bookmarks, []);
    assertEquals(view.api.session, null);
  } finally {
    await view.close();
  }
});

Deno.test("preference failures roll back and overlapping saves preserve latest intent", async () => {
  const first = deferred<Response>(), second = deferred<Response>();
  let writes = 0;
  const view = await mount((_url, init) =>
    init?.method === "PUT"
      ? (++writes === 1 ? first.promise : second.promise)
      : Promise.resolve(initial())
  );
  try {
    let a!: Promise<void>, b!: Promise<void>;
    await act(() => {
      a = view.api.updatePreferences({ readingListTag: "first" });
    });
    await act(() => {
      b = view.api.updatePreferences({ readingListTag: "second" });
    });
    assertEquals(writes, 1);
    assertEquals(view.api.preferences.readingListTag, "second");
    await act(async () => {
      first.resolve(
        Response.json({ preferences: { ...prefs, readingListTag: "first" } }),
      );
      await a;
    });
    assertEquals(writes, 2);
    assertEquals(view.api.preferences.readingListTag, "second");
    const rejection = assertRejects(() => b, Error, "not saved");
    await act(async () => {
      second.resolve(Response.json({ error: "offline" }, { status: 503 }));
      await rejection;
    });
    assertEquals(view.api.preferences.readingListTag, "first");
  } finally {
    await view.close();
  }
});

Deno.test("obsolete socket callbacks do not change a replacement connection", async () => {
  const view = await mount(() => Promise.resolve(initial()));
  try {
    const states: string[] = [];
    const connection = connectLiveEvents({
      onEvents: () => {},
      onStateChange: (s) => states.push(s),
    });
    const old = Socket.sockets[0];
    old.onopen();
    view.doc.hidden = true;
    view.doc.dispatchEvent(new Event("visibilitychange"));
    view.doc.hidden = false;
    view.doc.dispatchEvent(new Event("visibilitychange"));
    const current = Socket.sockets[1];
    current.onopen();
    const before = states.slice();
    old.onclose();
    old.onopen();
    assertEquals(states, before);
    connection.close();
    current.onopen();
    current.onclose();
    assertEquals(states.at(-1), "closed");
  } finally {
    await view.close();
  }
});

Deno.test("a local mutation during full refresh survives its old snapshot", async () => {
  const first = deferred<Response>(), second = deferred<Response>();
  let loads = 0;
  const view = await mount((url) =>
    url.startsWith("/api/initial-data")
      ? (++loads === 1 ? first.promise : second.promise)
      : Promise.resolve(Response.json({ tags: [] }))
  );
  try {
    let pending!: Promise<void>;
    await act(() => {
      pending = view.api.loadInitialData();
    });
    const added = bookmark("added");
    await act(() => view.api.addBookmark(added));
    await act(async () => {
      first.resolve(initial([]));
      await Promise.resolve();
    });
    assertEquals(view.api.bookmarks, [added]);
    await act(async () => {
      second.resolve(initial([added]));
      await pending;
    });
    assertEquals(view.api.bookmarks, [added]);
    assertEquals(loads, 2);
  } finally {
    await view.close();
  }
});
