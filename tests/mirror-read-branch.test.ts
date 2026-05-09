/**
 * Tests for U12: read-path mirror branching in initial-data, bookmarks, share.
 * Covers shouldReadFromMirror gating + handler swap behavior.
 */

import "./test-setup.ts";
import { clearMirrorTables } from "./mirror-test-setup.ts";

import { assertEquals } from "@std/assert";
import { app } from "../main.ts";
import { initOAuth } from "../lib/oauth-config.ts";
import { setTestSessionProvider } from "../lib/session.ts";
import { createMockSessionResult } from "./test-helpers.ts";
import {
  _resetMirrorModeCache,
  shouldReadFromMirror,
} from "../lib/mirror-config.ts";
import {
  upsertBookmark,
  upsertTag,
  upsertTrackedDid,
} from "../mirror/upserts.ts";

initOAuth(new URL("https://kipclip.com"));
const handler = app.handler();

const DID = "did:plc:test123";

function setMirrorMode(mode: "off" | "read") {
  Deno.env.set("MIRROR_MODE", mode);
  _resetMirrorModeCache();
}

function withSession() {
  setTestSessionProvider(() =>
    Promise.resolve(createMockSessionResult({ did: DID }))
  );
}

function clearSession() {
  setTestSessionProvider(null);
}

async function seed(rkey: string, createdAt: string) {
  await upsertBookmark({
    uri: `at://${DID}/community.lexicon.bookmarks.bookmark/${rkey}`,
    did: DID,
    rkey,
    cid: `bafy${rkey}`,
    subject: `https://example.com/${rkey}`,
    createdAt,
    tags: ["news"],
  });
}

Deno.test("shouldReadFromMirror - off mode never serves from mirror", async () => {
  await clearMirrorTables();
  setMirrorMode("off");
  await upsertTrackedDid({
    did: DID,
    backfillStartedAt: 1,
    backfillCompleteAt: 2,
  });
  const d = await shouldReadFromMirror(DID);
  assertEquals(d.fromMirror, false);
  assertEquals(d.syncing, false);
  setMirrorMode("off");
});

Deno.test("shouldReadFromMirror - read mode + tracked + started → mirror, not syncing", async () => {
  await clearMirrorTables();
  setMirrorMode("read");
  await upsertTrackedDid({
    did: DID,
    backfillStartedAt: 1,
    backfillCompleteAt: 2,
  });
  const d = await shouldReadFromMirror(DID);
  assertEquals(d.fromMirror, true);
  assertEquals(d.syncing, false);
  setMirrorMode("off");
});

Deno.test("shouldReadFromMirror - read mode + in-progress backfill → syncing=true", async () => {
  await clearMirrorTables();
  setMirrorMode("read");
  await upsertTrackedDid({ did: DID, backfillStartedAt: 1 });
  const d = await shouldReadFromMirror(DID);
  assertEquals(d.fromMirror, true);
  assertEquals(d.syncing, true);
  setMirrorMode("off");
});

Deno.test("shouldReadFromMirror - read mode + untracked DID → PDS fallback", async () => {
  await clearMirrorTables();
  setMirrorMode("read");
  const d = await shouldReadFromMirror(DID);
  assertEquals(d.fromMirror, false);
  setMirrorMode("off");
});

Deno.test("GET /api/initial-data - off mode hits PDS path (default behavior preserved)", async () => {
  setMirrorMode("off");
  withSession();
  try {
    const res = await handler(
      new Request("https://kipclip.com/api/initial-data"),
    );
    assertEquals(res.status, 200);
    const body = await res.json();
    // PDS mock returns empty rows in test env; key invariant is no syncing flag.
    assertEquals(body.syncing, undefined);
  } finally {
    clearSession();
    setMirrorMode("off");
  }
});

Deno.test("GET /api/initial-data - read mode + tracked DID serves from mirror", async () => {
  await clearMirrorTables();
  await seed("a", "2026-05-01T00:00:00.000Z");
  await seed("b", "2026-05-03T00:00:00.000Z");
  await upsertTrackedDid({
    did: DID,
    backfillStartedAt: 1,
    backfillCompleteAt: 2,
  });
  setMirrorMode("read");
  withSession();
  try {
    const res = await handler(
      new Request("https://kipclip.com/api/initial-data"),
    );
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.bookmarks.length, 2);
    assertEquals(body.bookmarks[0].uri.endsWith("/b"), true);
    assertEquals(body.syncing, undefined);
  } finally {
    clearSession();
    setMirrorMode("off");
  }
});

Deno.test("GET /api/initial-data - read mode + in-progress backfill sets syncing=true", async () => {
  await clearMirrorTables();
  await seed("a", "2026-05-01T00:00:00.000Z");
  await upsertTrackedDid({ did: DID, backfillStartedAt: 1 });
  setMirrorMode("read");
  withSession();
  try {
    const res = await handler(
      new Request("https://kipclip.com/api/initial-data"),
    );
    const body = await res.json();
    assertEquals(body.syncing, true);
  } finally {
    clearSession();
    setMirrorMode("off");
  }
});

Deno.test("GET /api/bookmarks - read mode + tracked DID serves from mirror", async () => {
  await clearMirrorTables();
  await seed("x", "2026-05-01T00:00:00.000Z");
  await upsertTrackedDid({
    did: DID,
    backfillStartedAt: 1,
    backfillCompleteAt: 2,
  });
  setMirrorMode("read");
  withSession();
  try {
    const res = await handler(
      new Request("https://kipclip.com/api/bookmarks"),
    );
    const body = await res.json();
    assertEquals(body.bookmarks.length, 1);
  } finally {
    clearSession();
    setMirrorMode("off");
  }
});

async function seedTag(rkey: string, value: string) {
  await upsertTag({
    uri: `at://${DID}/com.kipclip.tag/${rkey}`,
    did: DID,
    rkey,
    cid: `bafyTAG${rkey}`,
    value,
    createdAt: "2026-05-01T00:00:00.000Z",
  });
}

Deno.test("GET /api/tags - read mode + tracked DID serves from mirror", async () => {
  await clearMirrorTables();
  await seedTag("t1", "rust");
  await seedTag("t2", "deno");
  await upsertTrackedDid({
    did: DID,
    backfillStartedAt: 1,
    backfillCompleteAt: 2,
  });
  setMirrorMode("read");
  withSession();
  try {
    const res = await handler(new Request("https://kipclip.com/api/tags"));
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.tags.length, 2);
    const values = body.tags.map((t: { value: string }) => t.value).sort();
    assertEquals(values, ["deno", "rust"]);
  } finally {
    clearSession();
    setMirrorMode("off");
  }
});

Deno.test(
  "GET /api/tags - read mode + tracked DID + no mirror rows falls through to PDS (empty in test env)",
  async () => {
    // Safeguard: mirror empty → fall through to PDS. PDS mock returns [] in
    // test env so the assertion is the same, but the path is now PDS not mirror.
    await clearMirrorTables();
    await upsertTrackedDid({
      did: DID,
      backfillStartedAt: 1,
      backfillCompleteAt: 2,
    });
    setMirrorMode("read");
    withSession();
    try {
      const res = await handler(new Request("https://kipclip.com/api/tags"));
      assertEquals(res.status, 200);
      const body = await res.json();
      assertEquals(body.tags, []);
    } finally {
      clearSession();
      setMirrorMode("off");
    }
  },
);

Deno.test("GET /api/tags - off mode falls through to PDS path", async () => {
  await clearMirrorTables();
  await seedTag("t1", "should-not-appear");
  setMirrorMode("off");
  withSession();
  try {
    const res = await handler(new Request("https://kipclip.com/api/tags"));
    assertEquals(res.status, 200);
    const body = await res.json();
    // PDS mock returns empty rows in test env; key invariant is that mirror
    // rows did NOT bleed into the PDS-fallback response.
    assertEquals(body.tags, []);
  } finally {
    clearSession();
    setMirrorMode("off");
  }
});

Deno.test("GET /api/tags - no session returns 401", async () => {
  await clearMirrorTables();
  clearSession();
  setMirrorMode("off");
  const res = await handler(new Request("https://kipclip.com/api/tags"));
  assertEquals(res.status, 401);
});

// Regression: POST /api/bookmarks with a new tag must write the tag to the
// mirror immediately so GET /api/tags returns it without waiting for TAP.
// Previously createNewTagRecords was fire-and-forget with no mirror write —
// mirror users saw 0 tags in the sidebar until TAP delivered the event.
Deno.test(
  "POST /api/bookmarks with new tag → tag visible in GET /api/tags without TAP (mirror user)",
  async () => {
    await clearMirrorTables();
    await upsertTrackedDid({
      did: DID,
      backfillStartedAt: 1,
      backfillCompleteAt: 2,
    });
    setMirrorMode("read");

    // Function-based session mock so we can inspect request bodies and return
    // correct URIs for bookmark vs tag createRecord calls.
    setTestSessionProvider(() =>
      Promise.resolve({
        session: {
          did: DID,
          pdsUrl: "https://test.pds.example",
          handle: "test.handle",
          makeRequest: (
            _method: string,
            endpoint: string,
            opts?: { body?: unknown; headers?: Record<string, string> },
          ): Promise<Response> => {
            if (endpoint.includes("createRecord")) {
              const raw = opts?.body as string | undefined;
              const parsed = raw ? JSON.parse(raw) : {};
              const collection = parsed.collection ?? "";
              const isTag = collection.includes("com.kipclip.tag");
              const rkey = isTag ? "tagrkey1" : "bkrkey1";
              return Promise.resolve(
                new Response(
                  JSON.stringify({
                    uri: `at://${DID}/${collection}/${rkey}`,
                    cid: `cid-${rkey}`,
                  }),
                  {
                    status: 200,
                    headers: { "Content-Type": "application/json" },
                  },
                ),
              );
            }
            // listRecords, putRecord (annotation), etc.
            return Promise.resolve(
              new Response(JSON.stringify({ records: [] }), {
                status: 200,
                headers: { "Content-Type": "application/json" },
              }),
            );
          },
        } as any,
        setCookieHeader: "sid=mock; Path=/; HttpOnly",
      })
    );

    const origFetch = globalThis.fetch;
    globalThis.fetch = () =>
      Promise.resolve(
        new Response("<html><title>Test</title></html>", {
          status: 200,
          headers: { "Content-Type": "text/html" },
        }),
      );

    try {
      const res = await handler(
        new Request("https://kipclip.com/api/bookmarks", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url: "https://example.com", tags: ["rust"] }),
        }),
      );
      assertEquals(res.status, 200);
      const bookmarkBody = await res.json();
      assertEquals(bookmarkBody.bookmark.tags, ["rust"]);

      // createNewTagRecords fires from a .then() chain after the response is
      // returned. Yield to the microtask queue to let the chain settle:
      // PDS createRecord → upsertTag → mirror write.
      await new Promise((r) => setTimeout(r, 20));

      const tagsRes = await handler(
        new Request("https://kipclip.com/api/tags"),
      );
      assertEquals(tagsRes.status, 200);
      const tagsBody = await tagsRes.json();
      const tagValues = tagsBody.tags.map((t: { value: string }) => t.value);
      assertEquals(
        tagValues.includes("rust"),
        true,
        `tag must appear in sidebar without TAP; got: ${JSON.stringify(tagValues)}`,
      );
    } finally {
      setTestSessionProvider(null);
      globalThis.fetch = origFetch;
      setMirrorMode("off");
    }
  },
);
