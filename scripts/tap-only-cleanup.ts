/**
 * Approval-gated TAP-only enrollment cleanup (operator path).
 *
 * Lists TAP repos with no matching tracked_dids row ("TAP-only"), classifies
 * each from read-only evidence (PLC resolution + PDS probe + local state),
 * and — only with an explicit `--confirm <full-did>` token — removes the
 * STALE TAP ENROLLMENT for classified candidates.
 *
 * Safety contract:
 *   - DRY-RUN BY DEFAULT. `--confirm <did>` is the only way to remove
 *     anything, and the token must equal the full DID being removed.
 *   - Removes ONLY the TAP-side repo row. tracked_dids, missing_repos,
 *     mirror tables, and tap_repo_state are never touched here.
 *   - unavailable (DNS/refused/timeout/5xx), healthy (live repo — re-enroll,
 *     don't remove), and unresolved (PLC failed) DIDs are BLOCKED even with
 *     `--confirm`.
 *   - known-missing DIDs are listed apart and still need `--confirm`.
 *
 * Usage (on the box, where TAP_DB_PATH=/var/lib/tap/tap.db by default):
 *
 *   deno run -A scripts/tap-only-cleanup.ts                    # dry-run list
 *   deno run -A scripts/tap-only-cleanup.ts --did did:plc:…    # one DID
 *   deno run -A scripts/tap-only-cleanup.ts \
 *     --confirm did:plc:… --did did:plc:…                      # act on ONE did
 *
 * This tool NEVER runs automatically and never touches production data
 * other than the exact TAP repo row confirmed by the operator.
 */

import { db } from "../lib/db.ts";
import { withTapDb } from "../lib/tap-db.ts";
import { resolveDid } from "../lib/plc-resolver.ts";
import { listAll } from "../lib/mirror-sync.ts";
import { classifyPdsError, type PdsErrorClass } from "../lib/pds-error.ts";
import { isRepoNotFoundError } from "../lib/missing-repo.ts";
import {
  classifyTapOnlyDid,
  decideTapOnlyRemoval,
  type TapOnlyEvidence,
  type TapOnlyRow,
} from "../lib/tap-only-cleanup.ts";

const PROBE_COLLECTION = "community.lexicon.bookmarks.bookmark";

async function listTapOnlyDids(opts: { tapDbPath?: string } = {}) {
  const kipclip = await db.execute({
    sql: "SELECT did FROM tracked_dids",
    args: [],
  });
  const tracked = new Set(kipclip.rows.map((r) => String(r[0])));
  const tapDids = await withTapDb(opts, async (tapClient) => {
    const res = await tapClient.execute({
      sql: "SELECT did FROM repos",
      args: [],
    });
    return res.rows.map((row: unknown[]) => String(row[0]));
  });
  return tapDids.filter((did) => !tracked.has(did)).sort();
}

async function localEvidence(
  did: string,
): Promise<Pick<TapOnlyEvidence, "knownMissing" | "mirror" | "seen">> {
  const missing = await db.execute({
    sql: "SELECT 1 FROM missing_repos WHERE did = ?",
    args: [did],
  });
  const mirror = await db.execute({
    sql: "SELECT COUNT(*) FROM bookmarks WHERE did = ?",
    args: [did],
  });
  const seen = await db.execute({
    sql: "SELECT 1 FROM seen_dids WHERE did = ?",
    args: [did],
  });
  return {
    knownMissing: missing.rows.length > 0,
    mirror: Number(mirror.rows[0]?.[0] ?? 0),
    seen: seen.rows.length > 0,
  };
}

/** Probe the PLC-advertised PDS: healthy / missing (RepoNotFound) /
 * unavailable (infra) / not-probed (no PLC record). Read-only. */
async function probePds(did: string, pdsUrl: string): Promise<{
  pds: TapOnlyEvidence["pds"];
  errorClass: PdsErrorClass | null;
}> {
  try {
    await listAll(pdsUrl, did, PROBE_COLLECTION, 1);
    return { pds: "healthy", errorClass: null };
  } catch (err) {
    if (isRepoNotFoundError(err)) {
      return { pds: "missing", errorClass: "reponotfound" };
    }
    return { pds: "unavailable", errorClass: classifyPdsError(err) };
  }
}

async function classifyOne(did: string): Promise<
  TapOnlyRow & {
    plcPds: string | null;
    errorClass: string | null;
    evidence: TapOnlyEvidence;
  }
> {
  const local = await localEvidence(did);
  const resolved = await resolveDid(did);
  let pds: TapOnlyEvidence["pds"] = "not-probed";
  let errorClass: string | null = null;
  if (resolved) {
    const probe = await probePds(did, resolved.pdsUrl);
    pds = probe.pds;
    errorClass = probe.errorClass;
  }
  const evidence: TapOnlyEvidence = {
    plc: resolved ? { did: resolved.did, pdsUrl: resolved.pdsUrl } : null,
    pds,
    knownMissing: local.knownMissing,
    mirror: local.mirror,
    seen: local.seen,
  };
  const row = classifyTapOnlyDid(did, evidence);
  return { ...row, plcPds: resolved?.pdsUrl ?? null, errorClass, evidence };
}

function printRow(r: Awaited<ReturnType<typeof classifyOne>>): void {
  console.log(
    `  ${r.did}\n` +
      `    category: ${r.category}  reason: ${r.reason}\n` +
      `    plc-pds: ${r.plcPds ?? "none"}  probe: ${r.evidence.pds}` +
      (r.errorClass ? `  error-class: ${r.errorClass}` : "") +
      `  local: mirror=${r.evidence.mirror} knownMissing=${r.evidence.knownMissing} seen=${r.evidence.seen}`,
  );
}

async function removeTapEnrollment(did: string): Promise<void> {
  await withTapDb(undefined, async (tapClient) => {
    await tapClient.execute({
      sql: "DELETE FROM repos WHERE did = ?",
      args: [did],
    });
  });
}

async function main(): Promise<void> {
  const didFilter = Deno.args.includes("--did")
    ? Deno.args[Deno.args.indexOf("--did") + 1]
    : null;
  const confirmations = new Set<string>();
  for (let i = 0; i < Deno.args.length; i++) {
    if (Deno.args[i] === "--confirm") {
      const token = Deno.args[i + 1];
      if (token && token.startsWith("did:")) confirmations.add(token);
    }
  }

  let dids: string[];
  try {
    dids = await listTapOnlyDids();
  } catch (err) {
    console.error(`[tap-only-cleanup] cannot read TAP repos: ${err}`);
    Deno.exit(2);
  }
  if (didFilter) dids = dids.filter((d) => d === didFilter);
  if (dids.length === 0) {
    console.log("[tap-only-cleanup] no TAP-only DIDs to review");
    return;
  }

  console.log(
    `[tap-only-cleanup] ${dids.length} TAP-only DID(s) (no tracked_dids row)`,
  );
  const rows = [];
  for (const did of dids) {
    rows.push(await classifyOne(did));
  }

  const candidate = rows.filter((r) => r.category === "reponotfound");
  const suppressed = rows.filter((r) => r.category === "known-missing");
  const blocked = rows.filter((r) =>
    r.category === "unavailable" ||
    r.category === "healthy" ||
    r.category === "unresolved"
  );

  console.log(
    `[tap-only-cleanup] candidates=${candidate.length} suppressed=${suppressed.length} blocked=${blocked.length}`,
  );

  if (candidate.length > 0) {
    console.log("CANDIDATE (confirmed absent on a healthy PDS):");
    for (const r of candidate) printRow(r);
  }
  if (suppressed.length > 0) {
    console.log(
      "KNOWN-MISSING (kipclip evidence; suppressed from default list):",
    );
    for (const r of suppressed) printRow(r);
  }
  if (blocked.length > 0) {
    console.log(
      "BLOCKED (retained — infra uncertainty / live repo / unresolved):",
    );
    for (const r of blocked) printRow(r);
  }

  // Act only on explicitly confirmed candidate-ish rows.
  const toRemove: Awaited<ReturnType<typeof classifyOne>>[] = [];
  for (const r of [...candidate, ...suppressed]) {
    const decision = decideTapOnlyRemoval(
      r,
      confirmations.has(r.did) ? r.did : null,
    );
    if (decision.decision === "remove") toRemove.push(r);
  }

  if (toRemove.length === 0) {
    console.log(
      "[tap-only-cleanup] dry run — nothing removed. Re-run with --confirm <full-did> to remove a candidate.",
    );
    return;
  }

  console.log(
    `[tap-only-cleanup] REMOVING ${toRemove.length} TAP enrollment(s):`,
  );
  for (const r of toRemove) {
    await removeTapEnrollment(r.did);
    console.log(`  removed TAP repo row: ${r.did}`);
  }
  console.log(
    "[tap-only-cleanup] tracked_dids / missing_repos / mirror rows untouched.",
  );
}

await main();
