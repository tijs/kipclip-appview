/**
 * Tests for lib/missing-repo.ts — persistent missing-repo bookkeeping.
 */

import "./test-setup.ts";
import { clearMirrorTables, db } from "./mirror-test-setup.ts";
import { assertEquals } from "@std/assert";
import {
  forgetMissingRepo,
  isMissingRepo,
  listMissingRepos,
  recordMissingRepo,
} from "../lib/missing-repo.ts";

const DID = "did:plc:missing123";

async function withClean<T>(fn: () => Promise<T>): Promise<T> {
  await clearMirrorTables();
  try {
    return await fn();
  } finally {
    await clearMirrorTables();
  }
}

Deno.test("recordMissingRepo creates a row with timestamps", async () => {
  await withClean(async () => {
    const before = Date.now();
    await recordMissingRepo(DID, "RepoNotFound");
    const after = Date.now();

    const rows = await listMissingRepos();
    assertEquals(rows.length, 1);
    assertEquals(rows[0].did, DID);
    assertEquals(rows[0].missing_count, 1);
    assertEquals(rows[0].last_error, "RepoNotFound");
    assertEquals(rows[0].first_missing_at >= before, true);
    assertEquals(rows[0].first_missing_at <= after, true);
    assertEquals(rows[0].last_missing_at, rows[0].first_missing_at);
  });
});

Deno.test("recordMissingRepo increments count and updates last_missing_at", async () => {
  await withClean(async () => {
    await recordMissingRepo(DID, "first");
    const first = await listMissingRepos();
    const firstSeen = first[0].first_missing_at;

    await new Promise((r) => setTimeout(r, 10));
    await recordMissingRepo(DID, "second");
    const second = await listMissingRepos();

    assertEquals(second.length, 1);
    assertEquals(second[0].missing_count, 2);
    assertEquals(second[0].last_error, "second");
    assertEquals(second[0].first_missing_at, firstSeen);
    assertEquals(second[0].last_missing_at > firstSeen, true);
  });
});

Deno.test("isMissingRepo is true within window and false after", async () => {
  await withClean(async () => {
    const stale = Date.now() - 1_000;
    await db.execute({
      sql:
        "INSERT INTO missing_repos (did, first_missing_at, last_missing_at) VALUES (?, ?, ?)",
      args: [DID, stale, stale],
    });
    assertEquals(await isMissingRepo(DID, 60_000), true);
    assertEquals(await isMissingRepo(DID, 500), false);
  });
});

Deno.test("forgetMissingRepo removes the row", async () => {
  await withClean(async () => {
    await recordMissingRepo(DID);
    assertEquals((await listMissingRepos()).length, 1);
    await forgetMissingRepo(DID);
    assertEquals((await listMissingRepos()).length, 0);
  });
});

Deno.test("recordMissingRepo bounds the persisted error (first line, capped)", async () => {
  await withClean(async () => {
    const prefix = "listRecords community.lexicon.bookmarks.bookmark: 404 (";
    const longError = `${prefix}${"x".repeat(500)})`;
    await recordMissingRepo(DID, longError);
    const rows = await listMissingRepos();
    assertEquals(rows.length, 1);
    // Stored = first line, capped to 200 chars with a trailing ellipsis.
    const expected = `${prefix}${"x".repeat(200 - prefix.length - 1)}…`;
    assertEquals(rows[0].last_error, expected);
    assertEquals((rows[0].last_error ?? "").length, 200);
  });
});

Deno.test("recordMissingRepo persists only the first line of a multiline error", async () => {
  await withClean(async () => {
    await recordMissingRepo(DID, "first line\nsecond line with\nmore lines");
    const rows = await listMissingRepos();
    assertEquals(rows[0].last_error, "first line");
  });
});

Deno.test("recordMissingRepo stores null for absent or blank errors", async () => {
  await withClean(async () => {
    await recordMissingRepo(DID);
    assertEquals((await listMissingRepos())[0].last_error, null);

    await recordMissingRepo(DID, "");
    assertEquals((await listMissingRepos())[0].last_error, null);

    await recordMissingRepo(DID, "   \n\t\n");
    assertEquals((await listMissingRepos())[0].last_error, null);
  });
});
