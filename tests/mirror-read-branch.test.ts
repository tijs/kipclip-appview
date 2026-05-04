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
import { upsertBookmark, upsertTrackedDid } from "../mirror/upserts.ts";

initOAuth(new Request("https://kipclip.com"));
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
