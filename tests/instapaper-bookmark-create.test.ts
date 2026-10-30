import "./test-setup.ts";
import { assertEquals } from "@std/assert";
import { app } from "../main.ts";
import { setTestSessionProvider } from "../lib/session.ts";
import { updateUserSettings } from "../lib/settings.ts";
import {
  isKnownPreviousTags,
  sendReadingListBookmarkIfNew,
} from "../lib/instapaper.ts";
import { createMockSessionResult } from "./test-helpers.ts";

Deno.test("new bookmarks send to Instapaper only when the reading-list tag is present", async () => {
  assertEquals(isKnownPreviousTags(undefined), true);
  assertEquals(isKnownPreviousTags([]), true);
  assertEquals(isKnownPreviousTags(["toread"]), true);
  assertEquals(isKnownPreviousTags(null), false);
  assertEquals(isKnownPreviousTags("toread"), false);
  assertEquals(isKnownPreviousTags(["toread", 4]), false);
  const session = createMockSessionResult();
  const did = session.session!.did;
  let failCreate = false;
  let failPut = false;
  let previousTags: unknown = [];
  let preferenceReads = 0;
  let instapaperStatus = 201;
  let deliveries: string[] = [];
  let preference = () =>
    Response.json({
      value: { dateFormat: "us", readingListTag: "toread" },
    });
  let deliveryReceived!: () => void;
  const delivered = new Promise<void>((resolve) => {
    deliveryReceived = resolve;
  });
  session.session!.makeRequest = (_method, url) => {
    if (url.includes("listRecords")) {
      return Promise.resolve(Response.json({ records: [] }));
    }
    if (url.includes("getRecord")) {
      if (url.includes("community.lexicon.bookmarks.bookmark")) {
        return Promise.resolve(Response.json({
          uri: `at://${did}/community.lexicon.bookmarks.bookmark/abc123`,
          cid: "bafytest",
          value: {
            subject: "https://example.invalid/edited",
            createdAt: "2026-01-01T00:00:00.000Z",
            tags: previousTags,
          },
        }));
      }
      if (
        new URL(url).searchParams.get("collection") ===
          "com.kipclip.preferences"
      ) {
        preferenceReads++;
        return Promise.resolve(preference());
      }
      return Promise.resolve(
        Response.json({ error: "RecordNotFound" }, { status: 400 }),
      );
    }
    if (url.includes("putRecord") && failPut) {
      return Promise.resolve(
        Response.json({ error: "InvalidSwap" }, { status: 400 }),
      );
    }
    if (url.includes("createRecord") && failCreate) {
      return Promise.resolve(new Response("unavailable", { status: 503 }));
    }
    return Promise.resolve(Response.json({
      uri: `at://${did}/community.lexicon.bookmarks.bookmark/abc123`,
      cid: "bafytest",
    }));
  };
  await updateUserSettings(did, {
    instapaperEnabled: true,
    instapaperUsername: "dummy@example.invalid",
    instapaperPassword: "dummy-password",
  });
  const oldFetch = globalThis.fetch;
  globalThis.fetch = (input, options) => {
    const url = String(input);
    if (url.startsWith("https://www.instapaper.com/api/add")) {
      assertEquals(
        new Headers(options?.headers).get("Authorization"),
        "Basic " + btoa("dummy@example.invalid:dummy-password"),
      );
      deliveries.push(new URL(url).searchParams.get("url")!);
      deliveryReceived();
      return Promise.resolve(new Response(null, { status: instapaperStatus }));
    }
    return Promise.resolve(
      new Response("<html><title>Example</title></html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      }),
    );
  };
  setTestSessionProvider(() => Promise.resolve(session));
  const save = (url: string, tags: string[]) =>
    app.handler()(
      new Request("https://kipclip.com/api/bookmarks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url, tags }),
      }),
    );
  try {
    assertEquals(
      (await save("https://example.invalid/tagged", ["ToRead"])).status,
      200,
    );
    const timeout = setTimeout(() => deliveryReceived(), 2000);
    try {
      await delivered;
    } finally {
      clearTimeout(timeout);
    }
    assertEquals(deliveries, ["https://example.invalid/tagged"]);
    deliveries = [];
    await sendReadingListBookmarkIfNew(
      session.session!,
      ["other"],
      "https://example.invalid/untagged",
    );
    assertEquals(deliveries, []);
    await updateUserSettings(did, { instapaperEnabled: false });
    await sendReadingListBookmarkIfNew(
      session.session!,
      ["toread"],
      "https://example.invalid/disabled",
    );
    assertEquals(deliveries, []);
    await updateUserSettings(did, { instapaperEnabled: true });
    preference = () =>
      Response.json({ value: { readingListTag: "read-later" } });
    await sendReadingListBookmarkIfNew(
      session.session!,
      ["TOREAD"],
      "https://example.invalid/wrong-tag",
    );
    assertEquals(deliveries, []);
    await sendReadingListBookmarkIfNew(
      session.session!,
      ["Read-Later"],
      "https://example.invalid/custom",
    );
    assertEquals(deliveries, ["https://example.invalid/custom"]);
    deliveries = [];
    await sendReadingListBookmarkIfNew(
      session.session!,
      ["READ-LATER"],
      "https://example.invalid/already-tagged",
      undefined,
      ["read-later"],
    );
    assertEquals(deliveries, []);
    for (
      const invalid of [
        () => new Response(null, { status: 503 }),
        () => Response.json({ error: "unauthorized" }, { status: 403 }),
        () => Response.json({ value: { readingListTag: 42 } }),
        () => Response.json({}),
        () => new Response("not json", { status: 200 }),
        () => {
          throw new Error("network unavailable");
        },
      ]
    ) {
      preference = invalid;
      await sendReadingListBookmarkIfNew(
        session.session!,
        ["toread"],
        "https://example.invalid/unknown",
      );
    }
    assertEquals(deliveries, []);
    preference = () =>
      Response.json({ error: "RecordNotFound" }, { status: 400 });
    await sendReadingListBookmarkIfNew(
      session.session!,
      ["toread"],
      "https://example.invalid/default",
    );
    assertEquals(deliveries, ["https://example.invalid/default"]);
    deliveries = [];
    for (
      const defaultPreference of [
        () => Response.json({ error: "RecordNotFound" }, { status: 404 }),
        () => Response.json({ value: { dateFormat: "us" } }),
      ]
    ) {
      preference = defaultPreference;
      await sendReadingListBookmarkIfNew(
        session.session!,
        ["toread"],
        "https://example.invalid/default-variant",
      );
    }
    assertEquals(deliveries, [
      "https://example.invalid/default-variant",
      "https://example.invalid/default-variant",
    ]);
    deliveries = [];
    preference = () =>
      Response.json({ error: "RecordNotFound" }, { status: 400 });
    const editedDelivery = new Promise<void>((resolve) => {
      deliveryReceived = resolve;
    });
    const edit = await app.handler()(
      new Request(
        "https://kipclip.com/api/bookmarks/abc123",
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ tags: ["ToRead"] }),
        },
      ),
    );
    assertEquals(edit.status, 200);
    const editTimeout = setTimeout(() => deliveryReceived(), 2000);
    try {
      await editedDelivery;
    } finally {
      clearTimeout(editTimeout);
    }
    assertEquals(deliveries, ["https://example.invalid/edited"]);
    deliveries = [];
    const editRequest = () =>
      new Request("https://kipclip.com/api/bookmarks/abc123", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tags: ["toread"] }),
      });
    previousTags = "malformed";
    const readsBeforeMalformed = preferenceReads;
    assertEquals((await app.handler()(editRequest())).status, 200);
    assertEquals(preferenceReads, readsBeforeMalformed);
    assertEquals(deliveries, []);
    previousTags = [];
    failPut = true;
    const readsBeforeConflict = preferenceReads;
    assertEquals((await app.handler()(editRequest())).status, 409);
    assertEquals(preferenceReads, readsBeforeConflict);
    assertEquals(deliveries, []);
    failPut = false;
    instapaperStatus = 500;
    const failedDelivery = new Promise<void>((resolve) => {
      deliveryReceived = resolve;
    });
    assertEquals(
      (await save("https://example.invalid/instapaper-down", ["toread"]))
        .status,
      200,
    );
    const failedTimeout = setTimeout(() => deliveryReceived(), 2000);
    try {
      await failedDelivery;
    } finally {
      clearTimeout(failedTimeout);
    }
    assertEquals(deliveries, ["https://example.invalid/instapaper-down"]);
    deliveries = [];
    failCreate = true;
    assertEquals(
      (await save("https://example.invalid/failed", ["toread"])).status,
      500,
    );
    assertEquals(deliveries, []);
  } finally {
    globalThis.fetch = oldFetch;
    setTestSessionProvider(null);
  }
});
