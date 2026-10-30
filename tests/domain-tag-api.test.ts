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
