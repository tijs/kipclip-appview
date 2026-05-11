/**
 * Audit DIDs that have signed in (seen_dids) but were never enrolled in
 * the mirror (tracked_dids). Resolves each DID's PDS via plc.directory,
 * counts community.lexicon.bookmarks.bookmark records, and reports which
 * users have data on PDS that the appview has never mirrored.
 *
 * Companion to scripts/audit-mirror.ts. That one covers the tracked
 * cohort; this one covers the pre-auto-enroll cohort (users who signed
 * in before auto-enrollment was deployed, or who signed in via /save
 * and never hit /api/initial-data where auto-enroll fires).
 *
 * Usage (run on the box):
 *
 *   deno run -A scripts/audit-untracked.ts
 *   deno run -A scripts/audit-untracked.ts --json
 *   deno run -A scripts/audit-untracked.ts --limit 50  # cap for testing
 */

import { db } from "../lib/db.ts";
import { resolveDid } from "../lib/plc-resolver.ts";

/**
 * Resolve a did:web by fetching the canonical did.json at the domain
 * derived from the DID's identifier component. Per the did:web spec,
 * `did:web:example.com` → `https://example.com/.well-known/did.json`,
 * and `did:web:example.com:user:alice` → `https://example.com/user/alice/did.json`.
 */
async function resolveDidWeb(
  did: string,
): Promise<{ pdsUrl: string; handle: string | null } | null> {
  if (!did.startsWith("did:web:")) return null;
  const ident = did.slice("did:web:".length);
  const parts = ident.split(":").map((p) => decodeURIComponent(p));
  const host = parts[0];
  const path = parts.length === 1
    ? "/.well-known/did.json"
    : "/" + parts.slice(1).join("/") + "/did.json";
  try {
    const r = await fetch(`https://${host}${path}`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) return null;
    const doc = await r.json();
    const services: Array<
      { id?: string; type?: string; serviceEndpoint?: string }
    > = doc.service ?? [];
    const pds = services.find(
      (s) => s.id === "#atproto_pds" || s.type === "AtprotoPersonalDataServer",
    );
    if (!pds?.serviceEndpoint) return null;
    const aka: string[] = doc.alsoKnownAs ?? [];
    const handle = aka[0]?.replace("at://", "") ?? null;
    return { pdsUrl: pds.serviceEndpoint, handle };
  } catch {
    return null;
  }
}

interface Row {
  did: string;
  handle: string | null;
  pdsUrl: string | null;
  pdsBookmarks: number | null;
  error: string | null;
}

async function countPdsBookmarks(
  pdsUrl: string,
  did: string,
): Promise<number> {
  let total = 0;
  let cursor: string | undefined;
  for (let page = 0; page < 200; page++) {
    const url = new URL(`${pdsUrl}/xrpc/com.atproto.repo.listRecords`);
    url.searchParams.set("repo", did);
    url.searchParams.set("collection", "community.lexicon.bookmarks.bookmark");
    url.searchParams.set("limit", "100");
    if (cursor) url.searchParams.set("cursor", cursor);
    const res = await fetch(url.toString(), {
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`listRecords: ${res.status}`);
    const data = await res.json();
    const batch: unknown[] = data.records ?? [];
    total += batch.length;
    cursor = data.cursor;
    if (!cursor || batch.length === 0) break;
  }
  return total;
}

async function resolveHandle(did: string): Promise<string | null> {
  try {
    const r = await fetch(`https://plc.directory/${did}`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) return null;
    const doc = await r.json();
    const aka: string[] = doc.alsoKnownAs ?? [];
    return aka[0]?.replace("at://", "") ?? null;
  } catch {
    return null;
  }
}

async function main() {
  const jsonOut = Deno.args.includes("--json");
  const limitIdx = Deno.args.indexOf("--limit");
  const limit = limitIdx >= 0 ? Number(Deno.args[limitIdx + 1]) : -1;

  const untracked = await db.execute({
    sql: `
      SELECT did FROM seen_dids
      WHERE did NOT IN (SELECT did FROM tracked_dids)
      ORDER BY first_seen_at ASC
    `,
    args: [],
  });

  const dids = untracked.rows.map((r) => (r as [string])[0]);
  const work = limit > 0 ? dids.slice(0, limit) : dids;
  console.error(
    `[audit] ${work.length} untracked DIDs to scan` +
      (limit > 0 ? ` (limit ${limit} of ${dids.length})` : ""),
  );

  const rows: Row[] = [];
  let i = 0;
  for (const did of work) {
    i++;
    let pdsUrl: string | null = null;
    let handle: string | null = null;
    let pdsBookmarks: number | null = null;
    let error: string | null = null;

    try {
      if (did.startsWith("did:web:")) {
        const web = await resolveDidWeb(did);
        if (!web) {
          error = "did:web resolve failed";
        } else {
          pdsUrl = web.pdsUrl;
          handle = web.handle;
          pdsBookmarks = await countPdsBookmarks(pdsUrl, did);
        }
      } else {
        const resolved = await resolveDid(did);
        if (!resolved) {
          error = "PLC resolve failed";
        } else {
          pdsUrl = resolved.pdsUrl;
          handle = await resolveHandle(did);
          pdsBookmarks = await countPdsBookmarks(pdsUrl, did);
        }
      }
    } catch (err) {
      error = String(err).slice(0, 80);
    }

    rows.push({ did, handle, pdsUrl, pdsBookmarks, error });

    if (!jsonOut) {
      const tag = error
        ? `ERROR ${error}`
        : `pds=${pdsBookmarks} (${handle ?? "?"})`;
      console.error(`[${i}/${work.length}] ${did} ${tag}`);
    }
  }

  if (jsonOut) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }

  rows.sort((a, b) => (b.pdsBookmarks ?? -1) - (a.pdsBookmarks ?? -1));

  console.log("");
  console.log(
    "handle                                      did                                          pds  status",
  );
  console.log(
    "------------------------------------------- -------------------------------------------- ---- ------",
  );
  let withData = 0;
  let totalRecords = 0;
  for (const r of rows) {
    let status = "";
    if (r.error) status = `error: ${r.error.slice(0, 30)}`;
    else if ((r.pdsBookmarks ?? 0) > 0) {
      status = "RECOVER";
      withData++;
      totalRecords += r.pdsBookmarks ?? 0;
    } else status = "empty";
    console.log(
      `${(r.handle ?? "?").padEnd(43)} ${r.did.padEnd(44)} ${
        String(r.pdsBookmarks ?? "-").padStart(4)
      }  ${status}`,
    );
  }

  console.log("");
  console.log(
    `untracked=${rows.length} withData=${withData} totalPdsRecords=${totalRecords}`,
  );
}

await main();
