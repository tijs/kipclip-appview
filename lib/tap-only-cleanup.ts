/**
 * TAP-only enrollment classification and approval-gated selection.
 *
 * A "TAP-only" repo is a row in TAP's `repos` table with no matching
 * `tracked_dids` row — historically left behind by an abandoned enrollment
 * (the ordering bug fixed in v0.24.38) or by an old cleanup. Each TAP-only
 * DID is classified by read-only evidence:
 *
 *   - reponotfound   — the PLC-advertised PDS answered and reports the repo
 *                      absent. Candidate for approval-gated TAP removal.
 *   - known-missing  — kipclip already has missing_repos evidence for the
 *                      DID (confirmed absent). Candidate, but suppressed
 *                      from the DEFAULT list; needs explicit --confirm too.
 *   - unavailable    — PDS DNS/refused/timeout/5xx. RETENTION: never remove,
 *                      never classify as deletion; recheck when healthy.
 *   - healthy        — PDS answers with a live repo. RETENTION: never remove;
 *                      a repo that returned should be re-enrolled (idempotent
 *                      TAP /repos/add) rather than dropped.
 *   - unresolved     — PLC resolution failed. RETENTION: never remove.
 *
 * Removal is TAP-ONLY (DELETE FROM TAP repos) and gated by an explicit
 * confirmation token (`--confirm <full-did>`). trackeds_dids, missing_repos,
 * mirror rows, and the tap_repo_state book are never touched here.
 */

import type { ResolvedDid } from "./plc-resolver.ts";

export type TapOnlyCategory =
  | "reponotfound"
  | "known-missing"
  | "unavailable"
  | "healthy"
  | "unresolved";

export interface TapOnlyEvidence {
  /** PLC/DID-doc resolution result (null when resolution failed). */
  plc: Pick<ResolvedDid, "did" | "pdsUrl"> | null;
  /** Outcome of probing the advertised PDS, if one exists. */
  pds: "healthy" | "missing" | "unavailable" | "not-probed";
  /** True when missing_repos holds retention evidence for this DID. */
  knownMissing: boolean;
  /** Local mirror bookmark count (evidence of local retention). */
  mirror: number;
  /** True when the DID was ever seen by kipclip (seen_dids). */
  seen: boolean;
}

export interface TapOnlyRow {
  did: string;
  category: TapOnlyCategory;
  reason: string;
}

/**
 * Classify one TAP-only DID from read-only evidence. Order matters:
 * PLC/PDS absence beats an old missing record; infra uncertainty beats
 * nothing.
 */
export function classifyTapOnlyDid(
  did: string,
  ev: TapOnlyEvidence,
): TapOnlyRow {
  if (!ev.plc || !ev.plc.pdsUrl) {
    return {
      did,
      category: "unresolved",
      reason: "PLC/DID-doc resolution failed or advertises no PDS",
    };
  }
  if (ev.pds === "unavailable") {
    return {
      did,
      category: "unavailable",
      reason:
        "PDS unreachable (DNS/refused/timeout/5xx) — retention, not deletion",
    };
  }
  if (ev.pds === "missing") {
    return {
      did,
      category: "reponotfound",
      reason: "healthy PDS reports repo absent",
    };
  }
  if (ev.pds === "healthy") {
    return {
      did,
      category: "healthy",
      reason: "repo is live on its PDS — re-enroll, never remove",
    };
  }
  if (ev.knownMissing) {
    return {
      did,
      category: "known-missing",
      reason:
        "kipclip missing_repos evidence exists (suppressed from default list)",
    };
  }
  return {
    did,
    category: "unresolved",
    reason: "PDS could not be probed to a conclusion",
  };
}

export type RemovalDecision = "remove" | "blocked" | "suppressed";

/**
 * Decide the default proposal for a row, respecting suppression rules:
 *   - DEFAULT list: reponotfound only.
 *   - Suppressed (listed separately): known-missing.
 *   - Blocked (never removable even with --confirm): unavailable / healthy /
 *     unresolved.
 * `confirmation` is the full DID string; only a row whose category is
 * removable AND whose did exactly equals the token may be removed.
 */
export function decideTapOnlyRemoval(
  row: TapOnlyRow,
  confirmation: string | null,
): { decision: RemovalDecision; needsConfirmation?: boolean } {
  const removable = row.category === "reponotfound" ||
    row.category === "known-missing";
  if (!removable) return { decision: "blocked" };
  if (row.category === "known-missing") {
    return confirmation === row.did
      ? { decision: "remove" }
      : { decision: "suppressed", needsConfirmation: true };
  }
  return confirmation === row.did
    ? { decision: "remove" }
    : { decision: "suppressed", needsConfirmation: true };
}
