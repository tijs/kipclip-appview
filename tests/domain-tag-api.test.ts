import "./test-setup.ts";
import { assertEquals } from "@std/assert";
import { app } from "../main.ts";
import { setTestSessionProvider } from "../lib/session.ts";
import { createMockSessionResult } from "./test-helpers.ts";

Deno.test("domain rules read and update the user's PDS record", async () => {
  let record: any = {
    dateFormat: "eu",
    readingListTag: "later",
    custom: "preserved",
  };
  let cid = "bafyreioriginal";
  let writeCount = 0;
  const session = createMockSessionResult();
  session.session!.makeRequest = (method, _url, options) => {
    if (method === "GET") {
      return Promise.resolve(Response.json({ cid, value: record }));
    }
    const body = JSON.parse(String(options!.body));
    if (body.swapRecord !== cid) {
      return Promise.resolve(new Response("", { status: 409 }));
    }
    record = body.record;
    cid = `bafyreinew${++writeCount}`;
    return Promise.resolve(Response.json({ cid }));
  };
  setTestSessionProvider(() => Promise.resolve(session));
  try {
    const handler = app.handler();
    const put = await handler(
      new Request("https://kipclip.com/api/preferences", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          domainTagRules: [{ domain: "arxiv.org", tag: "paper" }],
          domainRulesRevision: "bafyreioriginal",
          custom: "malicious overwrite",
        }),
      }),
    );
    assertEquals(put.status, 200);
    assertEquals(record.custom, "preserved");
    assertEquals(record.readingListTag, "later");
    const get = await handler(
      new Request("https://kipclip.com/api/preferences/domain-tags"),
    );
    assertEquals(get.status, 200);
    const loaded = await get.json();
    assertEquals(loaded.rules, [{
      domain: "arxiv.org",
      tag: "paper",
    }]);
    const staleCid = loaded.cid;
    const updated = await handler(
      new Request("https://kipclip.com/api/preferences", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          domainRulesRevision: staleCid,
          domainTagRules: [
            { domain: "arxiv.org", tag: "paper" },
            { domain: "example.com", tag: "other" },
          ],
        }),
      }),
    );
    assertEquals(updated.status, 200);
    const stale = await handler(
      new Request("https://kipclip.com/api/preferences", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          domainRulesRevision: staleCid,
          domainTagRules: [],
        }),
      }),
    );
    assertEquals(stale.status, 409);
    assertEquals(record.domainTagRules.length, 2);
    const bad = await handler(
      new Request("https://kipclip.com/api/preferences", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          domainTagRules: [{ domain: "*.arxiv.org", tag: "paper" }],
        }),
      }),
    );
    assertEquals(bad.status, 400);
    assertEquals(record.domainTagRules.length, 2);
  } finally {
    setTestSessionProvider(null);
  }
});

Deno.test("domain rules reject unavailable and malformed PDS records", async () => {
  const session = createMockSessionResult();
  const handler = app.handler();
  const request = () =>
    handler(new Request("https://kipclip.com/api/preferences/domain-tags"));
  setTestSessionProvider(() => Promise.resolve(session));
  try {
    for (
      const response of [
        new Response("unavailable", { status: 503 }),
        Response.json({
          value: { domainTagRules: [{ domain: "*.example", tag: "x" }] },
          cid: "x",
        }),
        Response.json({ value: { domainTagRules: [] } }),
      ]
    ) {
      session.session!.makeRequest = () => Promise.resolve(response.clone());
      assertEquals((await request()).status, 503);
    }
    session.session!.makeRequest = () =>
      Promise.resolve(
        Response.json({ error: "RecordNotFound" }, { status: 400 }),
      );
    const empty = await request();
    assertEquals(await empty.json(), { rules: [], cid: null });
  } finally {
    setTestSessionProvider(null);
  }
});

Deno.test("preference validation rejects invalid inputs before writing", async () => {
  const session = createMockSessionResult();
  let writes = 0;
  session.session!.makeRequest = () => {
    writes++;
    return Promise.resolve(new Response("", { status: 500 }));
  };
  setTestSessionProvider(() => Promise.resolve(session));
  try {
    for (
      const body of [
        null,
        [],
        { domainTagRules: [], domainRulesRevision: "" },
        { dateFormat: "not-a-format" },
        { readingListTag: 42 },
        { readingListTag: "   " },
        { readingListTag: "bad tag!" },
      ]
    ) {
      const response = await app.handler()(
        new Request("https://kipclip.com/api/preferences", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
      );
      assertEquals(response.status, 400);
    }
    assertEquals(writes, 0);
  } finally {
    setTestSessionProvider(null);
  }
});
