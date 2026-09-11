/**
 * PDS probe error classification.
 *
 * Shared by the drift audit, reconcile targeting, and the TAP-only cleanup
 * operator path. Keeps the distinction that drives policy:
 *
 *   - `reponotfound` — the PLC-advertised PDS answered and reported the repo
 *     absent (400/404 RepoNotFound). Repo-level evidence: quarantine OK,
 *     never delete local data.
 *   - `auth`, `ratelimit`, `server-error` — the host answered but refused /
 *     failed. Infrastructure or configuration uncertainty, not absence.
 *   - `unavailable` — DNS / connection refused / timeout / transport error.
 *     Pure infrastructure uncertainty; cooldown and recheck, never deletion.
 *
 * The classifier only reads error objects — it never inspects payloads,
 * credentials, or event bodies.
 */

import { ListRecordsError } from "./mirror-sync.ts";
import { isRepoNotFoundError } from "./missing-repo.ts";

export type PdsErrorClass =
  | "reponotfound"
  | "auth"
  | "ratelimit"
  | "server-error"
  | "unavailable";

/** Classify a PDS listRecords / getRepoStatus failure. Unknown shapes are
 * conservatively `unavailable` (do not treat as absence). */
export function classifyPdsError(err: unknown): PdsErrorClass {
  if (isRepoNotFoundError(err)) return "reponotfound";
  if (err instanceof ListRecordsError) {
    if (err.status === 401 || err.status === 403) return "auth";
    if (err.status === 429) return "ratelimit";
    if (err.status >= 500) return "server-error";
    // 4xx other than RepoNotFound/auth/429 — treated as infra uncertainty
    // rather than repo absence (no confirmed RepoNotFound detail).
    return "unavailable";
  }
  return "unavailable";
}

/** Human-readable one-line summary of an error, staying bounded. Never raw
 * payloads — first line of the message, capped. */
export function errorSummary(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  const line = msg.split("\n")[0] ?? "";
  return line.length > 200 ? line.slice(0, 197) + "…" : line;
}
