import "./test-setup.ts";
import { assertEquals } from "@std/assert";
import { app } from "../main.ts";
import { setTestSessionProvider } from "../lib/session.ts";
import { updateUserSettings } from "../lib/settings.ts";
import { sendCreatedReadingListBookmark } from "../lib/instapaper.ts";
import { createMockSessionResult } from "./test-helpers.ts";

Deno.test("new bookmarks send to Instapaper only when the reading-list tag is present", async () => {
  const session = createMockSessionResult();
  const did = session.session!.did;
  let failCreate = false;
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
      return Promise.resolve(preference());
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
    await sendCreatedReadingListBookmark(
      session.session!,
      ["other"],
      "https://example.invalid/untagged",
    );
    assertEquals(deliveries, []);
    await updateUserSettings(did, { instapaperEnabled: false });
    await sendCreatedReadingListBookmark(
      session.session!,
      ["toread"],
      "https://example.invalid/disabled",
    );
    assertEquals(deliveries, []);
    await updateUserSettings(did, { instapaperEnabled: true });
    preference = () =>
      Response.json({ value: { readingListTag: "read-later" } });
    await sendCreatedReadingListBookmark(
      session.session!,
      ["TOREAD"],
      "https://example.invalid/wrong-tag",
    );
    assertEquals(deliveries, []);
    await sendCreatedReadingListBookmark(
      session.session!,
      ["Read-Later"],
      "https://example.invalid/custom",
    );
    assertEquals(deliveries, ["https://example.invalid/custom"]);
    deliveries = [];
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
      await sendCreatedReadingListBookmark(
        session.session!,
        ["toread"],
        "https://example.invalid/unknown",
      );
    }
    assertEquals(deliveries, []);
    preference = () =>
      Response.json({ error: "RecordNotFound" }, { status: 400 });
    await sendCreatedReadingListBookmark(
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
      await sendCreatedReadingListBookmark(
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
