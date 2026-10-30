import "./test-setup.ts";
import { assertEquals, assertRejects } from "@std/assert";
import { updateUserPreferences } from "../lib/preferences.ts";

Deno.test("updating preferences preserves unknown PDS fields and checks the record revision", async () => {
  let written: any;
  const session = {
    did: "did:plc:test",
    pdsUrl: "https://pds.example",
    makeRequest(method: string, _url: string, options?: { body: string }) {
      if (method === "GET") {
        return Promise.resolve(Response.json({
          cid: "bafyreicurrent",
          value: {
            dateFormat: "eu",
            readingListTag: "later",
            domainTagRules: [{ domain: "arxiv.org", tag: "paper" }],
            customField: "keep",
          },
        }));
      }
      written = JSON.parse(options!.body);
      return Promise.resolve(Response.json({ uri: "at://record" }));
    },
  };
  await updateUserPreferences(session, { dateFormat: "iso" });
  assertEquals(written.swapRecord, "bafyreicurrent");
  assertEquals(written.record.customField, "keep");
  assertEquals(written.record.domainTagRules, [{
    domain: "arxiv.org",
    tag: "paper",
  }]);
  assertEquals(written.record.dateFormat, "iso");
});

Deno.test("first preference write creates a valid typed PDS record", async () => {
  const session = {
    did: "did:plc:test",
    pdsUrl: "https://pds.example",
    makeRequest(method: string, _url: string, options?: { body: string }) {
      if (method === "GET") {
        return Promise.resolve(
          Response.json({ error: "RecordNotFound" }, { status: 400 }),
        );
      }
      const body = JSON.parse(options!.body);
      assertEquals(body.swapRecord, null);
      assertEquals(body.record.$type, "com.kipclip.preferences");
      assertEquals(body.record.dateFormat, "us");
      assertEquals(body.record.domainTagRules, [{
        domain: "arxiv.org",
        tag: "paper",
      }]);
      return Promise.resolve(Response.json({ cid: "new" }));
    },
  };
  await updateUserPreferences(session, {
    domainTagRules: [{ domain: "arxiv.org", tag: "paper" }],
  }, null);
});

Deno.test("failed PDS preference reads and writes are not reported as success", async () => {
  const failedRead = {
    did: "did:plc:test",
    pdsUrl: "https://pds.example",
    makeRequest: () => Promise.resolve(new Response("", { status: 503 })),
  };
  await assertRejects(() =>
    updateUserPreferences(failedRead, { dateFormat: "iso" })
  );
  const failedWrite = {
    did: "did:plc:test",
    pdsUrl: "https://pds.example",
    makeRequest: (method: string) =>
      Promise.resolve(
        method === "GET"
          ? Response.json({ error: "RecordNotFound" }, { status: 400 })
          : new Response("", { status: 409 }),
      ),
  };
  await assertRejects(() =>
    updateUserPreferences(failedWrite, { dateFormat: "iso" })
  );
});

for (const creating of [true, false]) {
  Deno.test(`concurrent ${creating ? "first creates" : "updates"} preserve the winning record`, async () => {
    let cid: string | null = creating ? null : "old";
    let stored: any = creating
      ? null
      : { dateFormat: "us", readingListTag: "later" };
    let reads = 0;
    let release!: () => void;
    const bothRead = new Promise<void>((resolve) => {
      release = resolve;
    });
    const session = {
      did: "did:plc:test",
      pdsUrl: "https://pds.example",
      async makeRequest(
        method: string,
        _url: string,
        options?: { body: string },
      ) {
        if (method === "GET") {
          const snapshotCid = cid;
          const snapshot = stored;
          if (++reads === 2) release();
          await bothRead;
          return snapshotCid === null
            ? Response.json({ error: "RecordNotFound" }, { status: 400 })
            : Response.json({ cid: snapshotCid, value: snapshot });
        }
        const body = JSON.parse(options!.body);
        if (body.swapRecord !== cid) {
          return Response.json({ error: "InvalidSwap" }, { status: 400 });
        }
        stored = body.record;
        cid = "winner";
        return Response.json({ cid });
      },
    };
    const startingCid = cid;
    const results = await Promise.allSettled([
      updateUserPreferences(session, {
        domainTagRules: [{ domain: "a.example", tag: "one" }],
      }, startingCid),
      updateUserPreferences(session, {
        domainTagRules: [{ domain: "b.example", tag: "two" }],
      }, startingCid),
    ]);
    assertEquals(
      results.filter((result) => result.status === "fulfilled").length,
      1,
    );
    assertEquals(
      results.filter((result) => result.status === "rejected").length,
      1,
    );
    assertEquals(stored.domainTagRules.length, 1);
    assertEquals(cid, "winner");
  });
}
