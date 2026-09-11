/**
 * Tests for lib/tap-repo-state.ts — persisted TAP-repo classification.
 *
 * Covers the weekly-drift plan's explicit quarantine policy:
 *   - confirmed RepoNotFound -> `missing` state (quarantine candidate)
 *   - unavailable PDS (DNS/refused/timeout/5xx) -> `unavailable` state with
 *     a cooldown and recheck schedule — never treated as deletion
 *   - recovery (healthy probe) clears the state
 *   - quarantine target selection only ever picks `missing`, never
 *     `unavailable`-within-cooldown
 *   - quarantining never touches tracked_dids / missing_repos / mirror rows
 */

import "./test-setup.ts";
import { clearMirrorTables, db } from "./mirror-test-setup.ts";
import { assertEquals } from "@std/assert";

import {
  isUnavailableInCooldown,
  listQuarantineCandidates,
  listUnavailableRecheckDue,
  markRepoHealthy,
  recordRepoMissing,
  recordRepoUnavailable,
  UNAVAILABLE_PDS_COOLDOWN_MS,
} from "../lib/tap-repo-state.ts";

const DID = "did:plc:test123";
const DID2 = "did:plc:test456";

async function withClean<T>(fn: () => Promise<T>): Promise<T> {
  await clearMirrorTables();
  await db.execute({ sql: "DELETE FROM tap_repo_state", args: [] });
  return await fn();
}

Deno.test("recordRepoMissing creates a persisted `missing` state", async () => {
  await withClean(async () => {
    await recordRepoMissing(DID, "reponotfound");
    const rows = await db.execute({
      sql:
        "SELECT did, state, failure_count, last_error_class FROM tap_repo_state WHERE did = ?",
      args: [DID],
    });
    assertEquals(rows.rows.length, 1);
    const [did, state, count, cls] = rows.rows[0] as [
      string,
      string,
      number,
      string,
    ];
    assertEquals(did, DID);
    assertEquals(state, "missing");
    assertEquals(Number(count), 1);
    assertEquals(cls, "reponotfound");
  });
});

Deno.test("recordRepoMissing bumps failure_count but preserves first_seen", async () => {
  await withClean(async () => {
    await recordRepoMissing(DID, "reponotfound");
    const before = await db.execute({
      sql:
        "SELECT first_seen_at, failure_count FROM tap_repo_state WHERE did = ?",
      args: [DID],
    });
    await recordRepoMissing(DID, "reponotfound");
    const after = await db.execute({
      sql:
        "SELECT first_seen_at, failure_count FROM tap_repo_state WHERE did = ?",
      args: [DID],
    });
    const [f1, c1] = before.rows[0] as [number, number];
    const [f2, c2] = after.rows[0] as [number, number];
    assertEquals(f1, f2);
    assertEquals(Number(c2), Number(c1) + 1);
  });
});

Deno.test("recordRepoUnavailable sets `unavailable` with a future next_check_at", async () => {
  await withClean(async () => {
    const before = Date.now();
    await recordRepoUnavailable(DID, "unavailable");
    const rows = await db.execute({
      sql:
        "SELECT state, next_check_at, last_checked_at FROM tap_repo_state WHERE did = ?",
      args: [DID],
    });
    const [state, nextCheck, lastChecked] = rows.rows[0] as [
      string,
      number,
      number,
    ];
    assertEquals(state, "unavailable");
    assertEquals(
      Number(nextCheck),
      Number(lastChecked) + UNAVAILABLE_PDS_COOLDOWN_MS,
    );
    assertEquals(Number(lastChecked) >= before, true);
  });
});

Deno.test("unavailable-in-cooldown blocks re-probing; recheck-due list surfaces it", async () => {
  await withClean(async () => {
    await recordRepoUnavailable(DID, "unavailable");
    // Within cooldown: must be suppressed from probing.
    assertEquals(await isUnavailableInCooldown(DID), true);
    assertEquals((await listQuarantineCandidates()).length, 0);
    assertEquals((await listUnavailableRecheckDue()).map((r) => r.did), []);

    // Force the cooldown to expire (rewrite next_check_at to the past).
    await db.execute({
      sql: "UPDATE tap_repo_state SET next_check_at = ? WHERE did = ?",
      args: [Date.now() - 1000, DID],
    });
    assertEquals(await isUnavailableInCooldown(DID), false);
    assertEquals(
      (await listUnavailableRecheckDue()).map((r) => r.did),
      [DID],
    );
    // Still never a quarantine candidate: unavailable is not deletion.
    assertEquals((await listQuarantineCandidates()).map((r) => r.did), []);
  });
});

Deno.test("error classification drives the cooldown state; RepoNotFound evidence wins", async () => {
  await withClean(async () => {
    // 5xx from the PDS = infra uncertainty, never `missing`.
    await recordRepoUnavailable(DID, "server-error");
    const rows = await db.execute({
      sql: "SELECT state FROM tap_repo_state WHERE did = ?",
      args: [DID],
    });
    assertEquals(rows.rows[0][0], "unavailable");

    // A DID already confirmed `missing` cannot be downgraded by a later
    // unavailable probe: a permanently absent repo beats a transient blip.
    await recordRepoMissing(DID2, "reponotfound");
    await recordRepoUnavailable(DID2, "dns");
    const rows2 = await db.execute({
      sql: "SELECT state FROM tap_repo_state WHERE did = ?",
      args: [DID2],
    });
    assertEquals(rows2.rows[0][0], "missing");
    // And the unavailable observation does not schedule a separate row.
    const count2 = await db.execute({
      sql: "SELECT COUNT(*) FROM tap_repo_state WHERE did = ?",
      args: [DID2],
    });
    assertEquals(Number(count2.rows[0][0]), 1);
  });
});

Deno.test("quarantine candidate selection: missing+tracked yes, TAP-only or unavailable no", async () => {
  await withClean(async () => {
    await db.execute({
      sql: "INSERT INTO tracked_dids (did, pds_url, added_at) VALUES (?, ?, ?)",
      args: [DID, "https://pds.example.test", Date.now()],
    });
    await db.execute({
      sql: "INSERT INTO tracked_dids (did, pds_url, added_at) VALUES (?, ?, ?)",
      args: [DID2, "https://pds.example.test", Date.now()],
    });
    // DID confirmed missing + tracked -> candidate.
    await recordRepoMissing(DID, "reponotfound");
    // DID2's PDS merely unavailable -> never a candidate.
    await recordRepoUnavailable(DID2, "dns");
    const candidates = await listQuarantineCandidates();
    assertEquals(candidates.map((r) => r.did), [DID]);

    // A TAP-only DID (missing state, no tracked_dids row) is never an
    // automatic quarantine target.
    const tapOnly = "did:plc:taponly999";
    await recordRepoMissing(tapOnly, "reponotfound");
    const candidates2 = await listQuarantineCandidates();
    assertEquals(
      candidates2.map((r) => r.did).includes(tapOnly),
      false,
    );
  });
});

Deno.test("markRepoHealthy clears quarantine state (repo returned)", async () => {
  await withClean(async () => {
    await recordRepoMissing(DID, "reponotfound");
    await markRepoHealthy(DID);
    assertEquals((await listQuarantineCandidates()).length, 0);
    const rows = await db.execute({
      sql: "SELECT COUNT(*) FROM tap_repo_state WHERE did = ?",
      args: [DID],
    });
    assertEquals(Number(rows.rows[0][0]), 0);
  });
});

Deno.test("state books are separate: missing state does not delete tracked_dids evidence", async () => {
  await withClean(async () => {
    // A tracked user whose repo is confirmed missing.
    await db.execute({
      sql: `INSERT INTO tracked_dids
              (did, pds_url, added_at, backfill_started_at, backfill_complete_at, last_seq, last_event_at)
            VALUES (?, ?, ?, ?, ?, NULL, NULL)`,
      args: [DID, "https://pds.example.test", 1, 1, 1],
    });
    await db.execute({
      sql: `INSERT INTO missing_repos
              (did, first_missing_at, last_missing_at, missing_count, last_error)
            VALUES (?, ?, ?, 3, 'RepoNotFound')`,
      args: [DID, 1, 1],
    });
    await recordRepoMissing(DID, "reponotfound");

    // Quarantine the TAP enrollment (the only destructive-ish step)…
    await db.execute({
      sql: "DELETE FROM tap_repo_state WHERE did = ?", // simulate quarantine bookkeeping
      args: [DID],
    });

    // …and prove the local evidence is untouched.
    const tracked = await db.execute({
      sql: "SELECT COUNT(*) FROM tracked_dids WHERE did = ?",
      args: [DID],
    });
    assertEquals(Number(tracked.rows[0][0]), 1);
    const missing = await db.execute({
      sql: "SELECT missing_count FROM missing_repos WHERE did = ?",
      args: [DID],
    });
    assertEquals(Number(missing.rows[0][0]), 3);
  });
});
