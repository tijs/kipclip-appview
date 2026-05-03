#!/usr/bin/env -S deno run -A
/**
 * Validate mirror correctness against a user's PDS.
 *
 * Usage:
 *   deno run -A scripts/mirror-diff.ts did:plc:xxxxx
 *
 * Read-only against PDS — uses unauthenticated `listRecords`. Compares
 * counts + URI sets + per-URI CIDs across bookmarks/annotations/tags.
 *
 * Exits 0 when clean. Exits 1 on any mismatch beyond the in-flight tolerance
 * (±1 across collections to account for events arriving during the script run).
 */

import { resolveDid } from "../lib/plc-resolver.ts";
import { paginateListRecordsPublic } from "../lib/pds-public.ts";
import { rawDb } from "../lib/db.ts";

const BOOKMARK_COLLECTION = "community.lexicon.bookmarks.bookmark";
const ANNOTATION_COLLECTIONS = [
  "app.bookmark.annotation",
  "com.kipclip.annotation",
];
const TAG_COLLECTION = "com.kipclip.tag";

const TOLERANCE = 1;

const did = Deno.args[0];
if (!did || !did.startsWith("did:")) {
  console.error("Usage: mirror-diff.ts <did:plc:...>");
  Deno.exit(2);
}

const resolved = await resolveDid(did);
if (!resolved) {
  console.error(`Could not resolve ${did}`);
  Deno.exit(2);
}
const { pdsUrl, handle } = resolved;
console.log(`Diffing ${did} (${handle}) at ${pdsUrl}`);

let mismatches = 0;

async function comparePdsToMirror(
  collection: string,
  mirrorTable: "bookmarks" | "annotations" | "tags",
): Promise<void> {
  const pdsRecords = await paginateListRecordsPublic(pdsUrl, did, collection)
    .catch((e) => {
      console.warn(`  ! ${collection} PDS list failed: ${e.message}`);
      return [];
    });
  const pdsCount = pdsRecords.length;
  const pdsByUri = new Map<string, string>();
  for (const r of pdsRecords) pdsByUri.set(r.uri as string, r.cid as string);

  const mirrorRows = await rawDb.execute({
    sql: `SELECT uri, cid FROM ${mirrorTable} WHERE did = ?`,
    args: [did],
  });
  const mirrorByUri = new Map<string, string>();
  for (const row of (mirrorRows.rows ?? [])) {
    const [uri, cid] = row as [string, string];
    mirrorByUri.set(uri, cid);
  }
  const mirrorCount = mirrorByUri.size;

  const diff = Math.abs(pdsCount - mirrorCount);
  const countOk = diff <= TOLERANCE;
  console.log(
    `  ${
      countOk ? "✓" : "✗"
    } ${collection}: PDS=${pdsCount} mirror=${mirrorCount}`,
  );
  if (!countOk) mismatches++;

  const onlyInPds: string[] = [];
  const onlyInMirror: string[] = [];
  const cidMismatches: string[] = [];
  for (const [uri, cid] of pdsByUri) {
    const m = mirrorByUri.get(uri);
    if (m === undefined) onlyInPds.push(uri);
    else if (m !== cid) cidMismatches.push(uri);
  }
  for (const uri of mirrorByUri.keys()) {
    if (!pdsByUri.has(uri)) onlyInMirror.push(uri);
  }

  if (onlyInPds.length > TOLERANCE) {
    mismatches++;
    console.log(`    ! only in PDS (${onlyInPds.length}):`);
    for (const u of onlyInPds.slice(0, 10)) console.log(`      ${u}`);
  }
  if (onlyInMirror.length > TOLERANCE) {
    mismatches++;
    console.log(`    ! only in mirror (${onlyInMirror.length}):`);
    for (const u of onlyInMirror.slice(0, 10)) console.log(`      ${u}`);
  }
  if (cidMismatches.length > 0) {
    mismatches++;
    console.log(`    ! CID mismatch (${cidMismatches.length}):`);
    for (const u of cidMismatches.slice(0, 10)) console.log(`      ${u}`);
  }
}

await comparePdsToMirror(BOOKMARK_COLLECTION, "bookmarks");
for (const c of ANNOTATION_COLLECTIONS) {
  await comparePdsToMirror(c, "annotations");
}
await comparePdsToMirror(TAG_COLLECTION, "tags");

if (mismatches === 0) {
  console.log("✓ Clean — mirror matches PDS within tolerance");
  Deno.exit(0);
} else {
  console.error(`✗ ${mismatches} mismatch group(s) detected`);
  Deno.exit(1);
}
