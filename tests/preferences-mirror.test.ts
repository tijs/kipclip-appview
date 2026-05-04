/**
 * Tests for lib/preferences.ts mirror branching:
 *   - reads from mirror when MIRROR_MODE=read + tracked DID + row exists
 *   - falls through to PDS otherwise
 */

import "./test-setup.ts";
import { clearMirrorTables } from "./mirror-test-setup.ts";

import { assertEquals } from "@std/assert";
import { _resetMirrorModeCache } from "../lib/mirror-config.ts";
import { getUserPreferences } from "../lib/preferences.ts";
import { upsertPreferences, upsertTrackedDid } from "../mirror/upserts.ts";

const DID = "did:plc:prefs-test";

function setMirrorMode(mode: "off" | "read") {
  Deno.env.set("MIRROR_MODE", mode);
  _resetMirrorModeCache();
}

interface MakeRequestCall {
  method: string;
  url: string;
}

function fakeSession(opts: {
  recordValue?: Record<string, unknown> | null;
  fail?: boolean;
}) {
  const calls: MakeRequestCall[] = [];
  const session = {
    did: DID,
    pdsUrl: "https://pds.example",
    makeRequest: (method: string, url: string) => {
      calls.push({ method, url });
      if (opts.fail) {
        return Promise.resolve(
          new Response(JSON.stringify({ error: "Not found" }), { status: 404 }),
        );
      }
      return Promise.resolve(
        new Response(
          JSON.stringify({ value: opts.recordValue ?? {} }),
          { status: 200 },
        ),
      );
    },
  };
  return { session, calls };
}

Deno.test("getUserPreferences - off mode: hits PDS", async () => {
  await clearMirrorTables();
  setMirrorMode("off");
  const { session, calls } = fakeSession({
    recordValue: { dateFormat: "iso", readingListTag: "later" },
  });
  const prefs = await getUserPreferences(session);
  assertEquals(prefs, { dateFormat: "iso", readingListTag: "later" });
  assertEquals(calls.length, 1);
  setMirrorMode("off");
});

Deno.test("getUserPreferences - read mode + tracked + mirror row: returns mirror, no PDS call", async () => {
  await clearMirrorTables();
  setMirrorMode("read");
  await upsertTrackedDid({
    did: DID,
    backfillStartedAt: 1,
    backfillCompleteAt: 2,
  });
  await upsertPreferences({
    did: DID,
    cid: "bafyP1",
    dateFormat: "iso",
    readingListTag: "later",
  });
  const { session, calls } = fakeSession({});
  const prefs = await getUserPreferences(session);
  assertEquals(prefs, { dateFormat: "iso", readingListTag: "later" });
  assertEquals(calls.length, 0);
  setMirrorMode("off");
});

Deno.test("getUserPreferences - read mode + tracked + no mirror row: falls through to PDS", async () => {
  await clearMirrorTables();
  setMirrorMode("read");
  await upsertTrackedDid({
    did: DID,
    backfillStartedAt: 1,
    backfillCompleteAt: 2,
  });
  const { session, calls } = fakeSession({
    recordValue: { dateFormat: "iso", readingListTag: "later" },
  });
  const prefs = await getUserPreferences(session);
  assertEquals(prefs, { dateFormat: "iso", readingListTag: "later" });
  assertEquals(calls.length, 1);
  setMirrorMode("off");
});

Deno.test("getUserPreferences - read mode + untracked DID: hits PDS", async () => {
  await clearMirrorTables();
  setMirrorMode("read");
  const { session, calls } = fakeSession({
    recordValue: { dateFormat: "us" },
  });
  const prefs = await getUserPreferences(session);
  assertEquals(prefs.dateFormat, "us");
  assertEquals(calls.length, 1);
  setMirrorMode("off");
});

Deno.test("getUserPreferences - mirror row with null fields fills defaults", async () => {
  await clearMirrorTables();
  setMirrorMode("read");
  await upsertTrackedDid({
    did: DID,
    backfillStartedAt: 1,
    backfillCompleteAt: 2,
  });
  await upsertPreferences({ did: DID, cid: "bafyP1" });
  const { session, calls } = fakeSession({});
  const prefs = await getUserPreferences(session);
  assertEquals(prefs, { dateFormat: "us", readingListTag: "toread" });
  assertEquals(calls.length, 0);
  setMirrorMode("off");
});
