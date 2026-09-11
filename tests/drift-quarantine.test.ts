/**
 * Tests for lib/drift-quarantine.ts — the drift-alert quarantine execution
 * and exit-code policy.
 *
 * Release blocker: quarantineMissingRepos() caught deleteTapRepoRows failures,
 * logged them, and returned 0 — a failed quarantine exited 0/clean. A failed
 * destructive step must surface as exit 2 (audit failure), never as a clean
 * run, and its diagnostic must be bounded (first line, length-capped).
 */

import "./test-setup.ts";
import { assertEquals } from "@std/assert";

import {
  type QuarantineOutcome,
  resolveDriftExit,
  runQuarantine,
  runTapQuarantine,
} from "../lib/drift-quarantine.ts";

const CANDIDATES = [
  {
    did: "did:plc:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    firstSeenAt: 1,
    failureCount: 3,
  },
  {
    did: "did:plc:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    firstSeenAt: 2,
    failureCount: 5,
  },
];

Deno.test("quarantine failure is surfaced, never swallowed as a clean count", async () => {
  const logs: string[] = [];
  const errs: string[] = [];
  const outcome = await runTapQuarantine(
    CANDIDATES,
    () =>
      Promise.reject(
        new Error(
          "read-back verification failed: still present in TAP repos: did:plc:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        ),
      ),
    (l) => logs.push(l),
    (l) => errs.push(l),
  );

  assertEquals(outcome.kind, "failed", "failure must be a 'failed' outcome");
  if (outcome.kind !== "failed") return;
  assertEquals(outcome.candidateCount, 2);
  // Bounded reason: first line only, no full multi-line error, capped length.
  assertEquals(outcome.reason.includes("\n"), false);
  assertEquals(
    outcome.reason.startsWith("Error: read-back verification failed"),
    true,
  );
  assertEquals(logs.length, 0, "no success lines may be emitted on failure");
  assertEquals(errs.length, 1);
  assertEquals(
    errs[0].includes("leaving 2 confirmed-missing repos for retry"),
    true,
  );
});

Deno.test("quarantine success reports verified-removed and already-absent counts", async () => {
  const outcome = await runTapQuarantine(
    CANDIDATES,
    (_dids) =>
      Promise.resolve({
        removed: [CANDIDATES[1].did],
        alreadyAbsent: [CANDIDATES[0].did],
      }),
  );
  assertEquals(outcome.kind, "done");
  if (outcome.kind !== "done") return;
  assertEquals(outcome.quarantined, 1);
  assertEquals(outcome.alreadyAbsent, 1);
});

Deno.test("no candidates is a noop outcome", async () => {
  const outcome = await runTapQuarantine([], () => {
    throw new Error("must never be called");
  });
  assertEquals(outcome.kind, "noop");
});

Deno.test("resolveDriftExit: failed quarantine -> 2 (audit failure) takes precedence", () => {
  // A destructive quarantine that could not be verified is the most severe
  // signal: it must override drift (1) AND classified PDS errors (3).
  assertEquals(
    resolveDriftExit({
      quarantineFailed: true,
      pdsErrorCount: 3,
      driftDetected: true,
    }),
    2,
  );
  assertEquals(
    resolveDriftExit({
      quarantineFailed: true,
      pdsErrorCount: 0,
      driftDetected: false,
    }),
    2,
  );
  // PDS errors keep exit 3; drift stays exit 1; clean run stays 0.
  assertEquals(
    resolveDriftExit({
      quarantineFailed: false,
      pdsErrorCount: 2,
      driftDetected: false,
    }),
    3,
  );
  assertEquals(
    resolveDriftExit({
      quarantineFailed: false,
      pdsErrorCount: 0,
      driftDetected: true,
    }),
    1,
  );
  assertEquals(
    resolveDriftExit({
      quarantineFailed: false,
      pdsErrorCount: 0,
      driftDetected: false,
    }),
    0,
  );
});

Deno.test("quarantine failure reason is bounded even for a giant error", async () => {
  const bigErr = "x".repeat(5000);
  const outcome = await runTapQuarantine(
    [CANDIDATES[0]],
    () => Promise.reject(new Error(bigErr)),
    () => {},
    () => {},
  );
  assertEquals(outcome.kind, "failed");
  if (outcome.kind === "failed") {
    assertEquals(outcome.reason.length <= 300, true);
  }
});

// Boundary regression: if listQuarantineCandidates() throws BEFORE
// runTapQuarantine() is invoked (e.g. the DB is unavailable), the throw must
// surface as a bounded `{kind:"failed", candidateCount:0, reason}` outcome so
// the documented exit policy resolves to exit 2 — NEVER an uncaught throw
// (Deno would exit 1). Candidates are unknown, so no count may be claimed and
// no delete may be attempted.
Deno.test("candidate listing failure is a 'failed' outcome (count 0, bounded), delete never attempted, exit resolves to 2", async () => {
  const logs: string[] = [];
  const errs: string[] = [];
  let deleteCalled = false;
  const outcome = await runQuarantine(
    () =>
      Promise.reject(
        new Error("db unavailable: SELECT on tap_repo_state failed"),
      ),
    () => {
      deleteCalled = true;
      return Promise.resolve({ removed: [], alreadyAbsent: [] });
    },
    (l) => logs.push(l),
    (l) => errs.push(l),
  );

  assertEquals(
    outcome.kind,
    "failed",
    "a candidate-listing failure must be a 'failed' outcome",
  );
  if (outcome.kind !== "failed") return;
  assertEquals(
    outcome.candidateCount,
    0,
    "candidates are unknown when listing fails — no count may be claimed",
  );
  assertEquals(
    outcome.reason.includes("\n"),
    false,
    "bounded: first line only",
  );
  assertEquals(outcome.reason.startsWith("Error: db unavailable"), true);
  assertEquals(
    deleteCalled,
    false,
    "no delete may run when the candidate list is unknown",
  );
  assertEquals(logs.length, 0, "no success lines on failure");
  assertEquals(errs.length, 1);
  assertEquals(errs[0].includes("candidate listing failed"), true);
  // The documented exit policy maps a failed quarantine to exit 2 (audit
  // failure), never an uncaught exit 1.
  assertEquals(
    resolveDriftExit({
      quarantineFailed: true,
      pdsErrorCount: 0,
      driftDetected: false,
    }),
    2,
  );
});

Deno.test("candidate listing failure reason is bounded even for a giant error", async () => {
  const outcome = await runQuarantine(
    () => Promise.reject(new Error("y".repeat(5000))),
    () => {
      throw new Error("delete must never run when listing failed");
    },
    () => {},
    () => {},
  );
  assertEquals(outcome.kind, "failed");
  if (outcome.kind === "failed") {
    assertEquals(outcome.reason.length <= 300, true);
    assertEquals(outcome.candidateCount, 0);
  }
});

Deno.test("runQuarantine lists candidates then runs the delete batch (success path unchanged)", async () => {
  const outcome = await runQuarantine(
    () => Promise.resolve(CANDIDATES),
    (dids) => Promise.resolve({ removed: [dids[0]], alreadyAbsent: [dids[1]] }),
  );
  assertEquals(outcome.kind, "done");
  if (outcome.kind !== "done") return;
  assertEquals(outcome.quarantined, 1);
  assertEquals(outcome.alreadyAbsent, 1);
});

Deno.test("runQuarantine empty list is a noop outcome", async () => {
  const outcome = await runQuarantine(() => Promise.resolve([]), () => {
    throw new Error("must never be called");
  });
  assertEquals(outcome.kind, "noop");
});

// Type-only guard so the QuarantineOutcome import is exercised (avoids
// unused-import churn if the shape ever changes).
const _typeGuard: QuarantineOutcome = { kind: "noop", reason: "no-candidates" };
void _typeGuard;
