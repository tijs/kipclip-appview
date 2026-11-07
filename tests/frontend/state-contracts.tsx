import React from "react";
import Renderer, { act } from "react-test-renderer";
import { assertEquals, assertRejects } from "@std/assert";
import { AppProvider, useApp } from "../../frontend/context/AppContext.tsx";
import { connectLiveEvents } from "../../frontend/lib/live-events.ts";
import type { EnrichedBookmark } from "../../shared/types.ts";

import { useMarkAsRead } from "../../frontend/hooks/useMarkAsRead.ts";
import { SwipeableRow } from "../../frontend/components/SwipeableRow.tsx";
import { ImportBookmarks } from "../../frontend/components/ImportBookmarks.tsx";
import { EditTag } from "../../frontend/components/EditTag.tsx";
import { Settings } from "../../frontend/components/Settings.tsx";
import { toast } from "sonner";

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
  children?: React.ReactNode,
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
      React.createElement(
        AppProvider,
        {},
        React.createElement(Probe),
        children,
      ),
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

Deno.test("an obsolete Undo action cannot undo the next bookmark", async () => {
  let actions!: ReturnType<typeof useMarkAsRead>;
  function Actions() {
    actions = useMarkAsRead();
    return null;
  }
  const view = await mount(
    (_url, init) =>
      Promise.resolve(
        Response.json({
          bookmark: {
            ...bookmark("a"),
            tags: JSON.parse(String(init?.body || "{}")).tags,
          },
        }),
      ),
    React.createElement(Actions),
  );
  try {
    const a = {
      ...bookmark("a"),
      tags: ["toread"],
      image: "https://a.test/image",
    };
    const b = {
      ...bookmark("b"),
      tags: ["toread"],
      image: "https://b.test/image",
    };
    await act(() => view.api.setBookmarks([a, b]));
    await act(() => actions.markAsRead(a));
    const old = actions.pending!.id;
    await act(() => actions.markAsRead(b));
    const current = actions.pending!.id;
    await act(() => actions.undo(old));
    assertEquals(view.api.bookmarks.map((b) => b.tags), [["read"], ["read"]]);
    await act(() => actions.undo(current));
    assertEquals(view.api.bookmarks.map((b) => b.tags), [["read"], ["toread"]]);
  } finally {
    await view.close();
  }
});

Deno.test("a swipe keeps its open-row baseline across moves and touch cancel", async () => {
  let root: any;
  let deletes = 0;
  await act(() => {
    root = Renderer.create(
      React.createElement(SwipeableRow, {
        onDelete: () => {
          deletes++;
          return Promise.resolve();
        },
        children: "row",
      }),
      { createNodeMock: () => ({ offsetWidth: 300 }) },
    );
  });
  const sliding = () =>
    root.root.findAllByType("div").find((node: any) => node.props.onTouchStart);
  const touch = (x: number) => ({ touches: [{ clientX: x, clientY: 0 }] });
  try {
    await act(() => sliding().props.onTouchStart(touch(200)));
    await act(() => sliding().props.onTouchMove(touch(140)));
    await act(() => sliding().props.onTouchEnd());
    assertEquals(sliding().props.style.transform, "translateX(-80px)");
    await act(() => sliding().props.onTouchStart(touch(200)));
    await act(() => sliding().props.onTouchMove(touch(180)));
    assertEquals(sliding().props.style.transform, "translateX(-100px)");
    await act(() => sliding().props.onTouchMove(touch(170)));
    assertEquals(sliding().props.style.transform, "translateX(-110px)");
    await act(() => sliding().props.onTouchCancel());
    assertEquals(sliding().props.style.transform, "translateX(-80px)");
    assertEquals(deletes, 0);
  } finally {
    await act(() => root.unmount());
  }
});

Deno.test("completed import retains its result when library refresh fails and offers refresh retry", async () => {
  let loads = 0, prepares = 0;
  const result = {
    imported: 0,
    skipped: 1,
    failed: 0,
    total: 1,
    format: "pinboard",
  };
  const view = await mount((url) => {
    if (url === "/api/import") {
      prepares++;
      return Promise.resolve(Response.json({ success: true, result }));
    }
    if (url.startsWith("/api/initial-data")) {
      return Promise.resolve(
        ++loads === 1
          ? Response.json({
            bookmarks: [],
            preferences: prefs,
            isSupporter: true,
          })
          : Response.json({ error: "offline" }, { status: 503 }),
      );
    }
    return Promise.resolve(Response.json({ tags: [] }));
  }, React.createElement(ImportBookmarks));
  try {
    await act(() => view.api.loadInitialData());
    await act(() =>
      view.root.root.findByProps({ type: "file" }).props.onChange({
        target: { files: [new File(["[]"], "pinboard.json")] },
      })
    );
    const button = view.root.root.findAllByType("button").find((n: any) =>
      JSON.stringify(n.props.children).includes("Import Bookmarks")
    );
    await act(() => button.props.onClick());
    const rendered = JSON.stringify(view.root.toJSON());
    assertEquals(rendered.includes("Import complete ("), true);
    assertEquals(rendered.includes("Import failed"), false);
    assertEquals(rendered.includes("Retry refresh"), true);
    assertEquals(prepares, 1);
    const retry = view.root.root.findAllByType("button").find((n: any) =>
      n.props.children === "Retry refresh"
    );
    await act(() => retry.props.onClick());
    assertEquals(prepares, 1);
  } finally {
    await view.close();
  }
});

Deno.test("tag rename reports the committed mutation even when bookmark refresh fails", async () => {
  let saved = 0;
  const tag = {
    uri: "at://did:plc:test/com.kipclip.tag/a",
    cid: "tag",
    value: "old",
    createdAt: "2026-01-01T00:00:00Z",
  };
  const view = await mount(
    (url, init) =>
      Promise.resolve(
        url === "/api/bookmarks"
          ? Response.json({ error: "offline" }, { status: 503 })
          : Response.json({
            tag: {
              ...tag,
              value: JSON.parse(String(init?.body || "{}")).value,
            },
          }),
      ),
    React.createElement(EditTag, {
      tag,
      onClose: () => {},
      onTagUpdated: () => {
        saved++;
      },
      onTagDeleted: () => {},
    }),
  );
  try {
    await act(() =>
      view.root.root.findByProps({ id: "tag-value" }).props.onChange({
        target: { value: "new" },
      })
    );
    await act(() =>
      view.root.root.findByType("form").props.onSubmit({ preventDefault() {} })
    );
    assertEquals(saved, 1);
    assertEquals(
      JSON.stringify(view.root.toJSON()).includes("Failed to update tag"),
      false,
    );
    assertEquals(
      toast.getHistory().some((t: any) =>
        t.title === "Tag saved, but bookmarks could not refresh"
      ),
      true,
    );
  } finally {
    toast.dismiss();
    await view.close();
  }
});

Deno.test("settings expose failed preference save and a working retry", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "history");
  Object.defineProperty(globalThis, "history", {
    configurable: true,
    value: { replaceState() {} },
  });
  let writes = 0;
  const view = await mount((url, init) => {
    if (url === "/api/preferences" && init?.method === "PUT") {
      return Promise.resolve(
        ++writes === 1
          ? Response.json({ error: "offline" }, { status: 503 })
          : Response.json({
            preferences: { ...prefs, readingListTag: "later" },
          }),
      );
    }
    return Promise.resolve(
      Response.json({ rules: [], cid: "rules", tags: [] }),
    );
  }, React.createElement(Settings));
  try {
    await act(() =>
      view.root.root.findByProps({ id: "readingListTag" }).props.onChange({
        target: { value: "later" },
      })
    );
    await act(() =>
      view.root.root.findByProps({ id: "readingListTag" }).props.onBlur()
    );
    assertEquals(view.api.preferences.readingListTag, "toread");
    assertEquals(
      JSON.stringify(view.root.toJSON()).includes("Retry save"),
      true,
    );
    const retry = view.root.root.findAllByType("button").find((n: any) =>
      n.props.children === "Retry save"
    );
    await act(() => retry.props.onClick());
    assertEquals(view.api.preferences.readingListTag, "later");
    assertEquals(writes, 2);
  } finally {
    await view.close();
    if (descriptor) Object.defineProperty(globalThis, "history", descriptor);
    else delete (globalThis as any).history;
  }
});
