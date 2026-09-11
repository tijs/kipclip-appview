/**
 * Drift-alert quarantine execution + exit-code policy.
 *
 * The daily drift alert QUARANTINES confirmed-missing repos by removing ONLY
 * their TAP enrollment (tap.db repo rows) — tracked_dids, mirror rows, and
 * missing_repos evidence are never touched and unavailable-PDS rows are never
 * candidates. That deletion is destructive, so a failure to delete (or to
 * verify the row is gone — deleteTapRepoRows already reads back the exact
 * target) must NEVER be swallowed as a clean run: the alert surfaces the
 * failure with a bounded diagnostic and exits with the audit-failure code
 * (2) so operators see the quarantine did not complete.
 */

import type { TapDeleteResult } from "./tap-delete.ts";

export type QuarantineOutcome =
  | { kind: "noop"; reason: "no-candidates" }
  | { kind: "done"; quarantined: number; alreadyAbsent: number }
  | { kind: "failed"; candidateCount: number; reason: string };

export interface QuarantineCandidate {
  did: string;
  firstSeenAt: number;
  failureCount: number;
}

/** First line + 300-char bound: error text can embed DID lists, keep it
 * single-line and small for operator journals and Sentry extras. */
function boundedReason(err: unknown): string {
  const line = String(err).split("\n")[0] ?? "";
  return line.length > 300 ? line.slice(0, 297) + "…" : line;
}

/**
 * Run the quarantine batch against an injected delete function (the real
 * caller passes deleteTapRepoRows; tests inject fakes). A throwing delete is
 * surfaced as `{kind:"failed"}` with the candidate count and a bounded
 * reason — never mapped to a clean count and never claimed successful
 * without read-back (the wrapper below already verifies read-back).
 */
export async function runTapQuarantine(
  candidates: readonly QuarantineCandidate[],
  deleteRows: (dids: string[]) => Promise<TapDeleteResult>,
  log: (line: string) => void = console.log,
  logError: (line: string) => void = console.error,
): Promise<QuarantineOutcome> {
  if (candidates.length === 0) {
    return { kind: "noop", reason: "no-candidates" };
  }
  const dids = candidates.map((c) => c.did);
  let deleted: TapDeleteResult;
  try {
    deleted = await deleteRows(dids);
  } catch (err) {
    const reason = boundedReason(err);
    logError(
      `[drift-alert] TAP quarantine FAILED (read-back not confirmed); leaving ${dids.length} confirmed-missing repos for retry: ${reason}`,
    );
    return { kind: "failed", candidateCount: dids.length, reason };
  }
  // Quarantine is complete only for DIDs whose TAP row is verified gone.
  for (const c of candidates) {
    const wasRemoved = deleted.removed.includes(c.did);
    log(
      `[drift-alert] quarantined (TAP enrollment ${
        wasRemoved ? "removed + verified absent" : "was already absent"
      }, local state kept): ${c.did} (first seen ${
        new Date(c.firstSeenAt).toISOString()
      }, ${c.failureCount} confirmations)`,
    );
  }
  if (deleted.alreadyAbsent.length > 0) {
    log(
      `[drift-alert] TAP quarantine: ${deleted.alreadyAbsent.length} candidate(s) had no TAP row (idempotent no-op)`,
    );
  }
  return {
    kind: "done",
    quarantined: deleted.removed.length,
    alreadyAbsent: deleted.alreadyAbsent.length,
  };
}

/**
 * Full quarantine boundary: list the candidates, then run the delete batch.
 * A throw from the candidate LISTING (e.g. the DB is unavailable) happens
 * BEFORE runTapQuarantine is ever invoked — if it escaped, main() would die
 * on an uncaught error (Deno exits 1) instead of the documented audit
 * failure (exit 2). Surface it as a bounded `{kind:"failed",
 * candidateCount:0, reason}`: the candidates are UNKNOWN, so no count may be
 * claimed and no delete may be attempted; the caller's exit policy still
 * resolves to exit 2.
 */
export async function runQuarantine(
  listCandidates: () => Promise<readonly QuarantineCandidate[]>,
  deleteRows: (dids: string[]) => Promise<TapDeleteResult>,
  log: (line: string) => void = console.log,
  logError: (line: string) => void = console.error,
): Promise<QuarantineOutcome> {
  let candidates: readonly QuarantineCandidate[];
  try {
    candidates = await listCandidates();
  } catch (err) {
    const reason = boundedReason(err);
    logError(
      `[drift-alert] TAP quarantine FAILED (candidate listing failed; nothing deleted), leaving confirmed-missing repos for retry: ${reason}`,
    );
    return { kind: "failed", candidateCount: 0, reason };
  }
  return runTapQuarantine(candidates, deleteRows, log, logError);
}

/**
 * Final drift-alert exit-code policy. A failed quarantine is an INTERNAL
 * audit failure and surfaces as exit 2 (audit failed) — it takes precedence
 * over recoverable drift (1) and classified PDS errors (3), because a
 * destructive step that could not be verified is the most severe signal and
 * must never be reported as a clean run (0). Exit 3 stays reserved for
 * classified PDS errors, exit 1 for recoverable drift.
 */
export function resolveDriftExit(opts: {
  quarantineFailed: boolean;
  pdsErrorCount: number;
  driftDetected: boolean;
}): 0 | 1 | 2 | 3 {
  if (opts.quarantineFailed) return 2;
  if (opts.pdsErrorCount > 0) return 3;
  return opts.driftDetected ? 1 : 0;
}
