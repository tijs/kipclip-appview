import { assertEquals, assertRejects } from "@std/assert";
import { openOAuthPopup } from "../frontend/utils/pwa.ts";

function harness(immediate = false) {
  const names = [
    "localStorage",
    "screen",
    "open",
    "location",
    "setTimeout",
    "clearTimeout",
    "setInterval",
    "clearInterval",
    "addEventListener",
    "removeEventListener",
  ];
  const saved = names.map((n) =>
    Object.getOwnPropertyDescriptor(globalThis, n)
  );
  const store = new Map<string, string>(),
    listeners = new Map<string, Set<(event: any) => void>>(),
    timers = new Map<number, () => void>();
  let timer = 0;
  const popup = {};
  const success = {
    type: "oauth-callback",
    success: true,
    did: "did:plc:test",
    handle: "test.example",
  };
  const replacements: any = {
    localStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => store.set(k, v),
      removeItem: (k: string) => store.delete(k),
    },
    screen: { width: 1000, height: 800 },
    location: { origin: "https://kipclip.test" },
    open: () => {
      if (immediate) store.set("pwa-oauth-result", JSON.stringify(success));
      return popup;
    },
    setTimeout: (cb: () => void) => {
      timers.set(++timer, cb);
      return timer;
    },
    clearTimeout: (id: number) => timers.delete(id),
    setInterval: (cb: () => void) => {
      timers.set(++timer, cb);
      return timer;
    },
    clearInterval: (id: number) => timers.delete(id),
    addEventListener: (name: string, cb: (e: any) => void) => {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name)!.add(cb);
    },
    removeEventListener: (name: string, cb: (e: any) => void) =>
      listeners.get(name)?.delete(cb),
  };
  names.forEach((n) =>
    Object.defineProperty(globalThis, n, {
      configurable: true,
      value: replacements[n],
    })
  );
  return {
    success,
    popup,
    timers,
    listeners,
    emit: (event: any) => listeners.get("message")?.forEach((cb) => cb(event)),
    restore: () =>
      names.forEach((n, i) => {
        if (saved[i]) Object.defineProperty(globalThis, n, saved[i]!);
        else delete (globalThis as any)[n];
      }),
  };
}
Deno.test("OAuth popup ignores unrelated messages and settles once with timer cleanup", async () => {
  const h = harness();
  try {
    const result = openOAuthPopup("/oauth/login");
    let settled = false;
    result.then(() => settled = true);
    h.emit({ origin: "https://evil.test", source: h.popup, data: h.success });
    h.emit({ origin: "https://kipclip.test", source: {}, data: h.success });
    await Promise.resolve();
    assertEquals(settled, false);
    h.emit({
      origin: "https://kipclip.test",
      source: h.popup,
      data: h.success,
    });
    assertEquals(await result, {
      did: h.success.did,
      handle: h.success.handle,
    });
    assertEquals(h.timers.size, 0);
    assertEquals(h.listeners.get("message")?.size, 0);
  } finally {
    h.restore();
  }
});
Deno.test("an immediate stored OAuth result completes after all cleanup handles exist", async () => {
  const h = harness(true);
  try {
    assertEquals(await openOAuthPopup("/oauth/login"), {
      did: h.success.did,
      handle: h.success.handle,
    });
    assertEquals(h.timers.size, 0);
    assertEquals(h.listeners.get("storage")?.size, 0);
  } finally {
    h.restore();
  }
});
Deno.test("OAuth timeout rejects and cancels outstanding poll callbacks", async () => {
  const h = harness();
  const now = Date.now;
  let time = now();
  Date.now = () => time;
  try {
    const result = openOAuthPopup("/oauth/login");
    time += 6 * 60_000;
    const rejected = assertRejects(() => result, Error, "Login timed out");
    [...h.timers.values()][0]();
    await rejected;
    assertEquals(h.timers.size, 0);
    assertEquals(h.listeners.get("message")?.size, 0);
  } finally {
    Date.now = now;
    h.restore();
  }
});
