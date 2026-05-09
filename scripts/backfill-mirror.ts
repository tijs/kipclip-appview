/**
 * One-shot PDS → mirror backfill for a single DID.
 *
 * Run on the box:
 *   DID=did:plc:... deno run --allow-net --allow-env --allow-read scripts/backfill-mirror.ts
 *
 * DATABASE_URL defaults to file:.local/kipclip.db (dev); set it to the
 * production path before running:
 *   DATABASE_URL=file:/var/lib/kipclip/kipclip.db DID=did:plc:... deno run ...
 *
 * The script:
 *  1. Resolves the DID document to find the PDS endpoint.
 *  2. Inserts a tracked_dids row (INSERT OR IGNORE) with backfill_started_at.
 *  3. Paginates all bookmark / annotation / tag / preference records from PDS.
 *  4. Upserts each into the local mirror DB.
 *  5. Stamps backfill_complete_at on the tracked_dids row.
 */

import { createClient } from "@libsql/client";

const DID = Deno.env.get("DID");
if (!DID) {
  console.error("DID env var required. Example: DID=did:plc:... deno run ...");
  Deno.exit(1);
}

const DATABASE_URL = Deno.env.get("DATABASE_URL") ?? "file:.local/kipclip.db";

const db = createClient({ url: DATABASE_URL });

// --- helpers -----------------------------------------------------------

async function listAll(
  pdsUrl: string,
  did: string,
  collection: string,
): Promise<any[]> {
  const records: any[] = [];
  let cursor: string | undefined;
  let page = 0;
  while (true) {
    const url = new URL(`${pdsUrl}/xrpc/com.atproto.repo.listRecords`);
    url.searchParams.set("repo", did);
    url.searchParams.set("collection", collection);
    url.searchParams.set("limit", "100");
    if (cursor) url.searchParams.set("cursor", cursor);

    const res = await fetch(url.toString());
    if (!res.ok) {
      const text = await res.text();
      throw new Error(
        `listRecords ${collection} page ${page}: ${res.status} ${text}`,
      );
    }
    const data = await res.json();
    const batch: any[] = data.records ?? [];
    records.push(...batch);
    cursor = data.cursor;
    page++;
    if (!cursor || batch.length === 0) break;
    if (page % 10 === 0) {
      console.log(`  ${collection}: fetched ${records.length} so far…`);
    }
  }
  return records;
}

function str(obj: unknown, key: string): string | undefined {
  if (obj && typeof obj === "object" && key in (obj as object)) {
    const v = (obj as Record<string, unknown>)[key];
    return typeof v === "string" ? v : undefined;
  }
}

function arr(val: unknown): string[] {
  if (!Array.isArray(val)) return [];
  return val.filter((x): x is string => typeof x === "string");
}

// --- resolve PDS URL ---------------------------------------------------

console.log(`Resolving DID document for ${DID}…`);
const didDoc = await fetch(`https://plc.directory/${DID}`).then((r) =>
  r.json()
);
const pdsService = (didDoc.service as any[])?.find((s: any) =>
  s.id === "#atproto_pds"
);
if (!pdsService) throw new Error("No atproto PDS service in DID document");
const PDS_URL: string = pdsService.serviceEndpoint;
console.log(`PDS: ${PDS_URL}`);

// --- step 1: ensure tracked_dids row -----------------------------------

const now = Date.now();
await db.execute({
  sql: `INSERT OR IGNORE INTO tracked_dids
          (did, pds_url, added_at, backfill_started_at, backfill_complete_at, last_seq, last_event_at)
        VALUES (?, ?, ?, ?, NULL, NULL, NULL)`,
  args: [DID, PDS_URL, now, now],
});
console.log("tracked_dids row ensured (INSERT OR IGNORE)");

// --- step 2: backfill bookmarks ----------------------------------------

console.log("Fetching bookmarks…");
const bookmarks = await listAll(
  PDS_URL,
  DID,
  "community.lexicon.bookmarks.bookmark",
);
console.log(`  → ${bookmarks.length} bookmarks`);

for (const r of bookmarks) {
  const rkey = r.uri.split("/").pop() ?? "";
  const v = r.value ?? {};
  const enriched = (v["$enriched"] as Record<string, unknown>) ?? {};
  await db.execute({
    sql: `INSERT OR REPLACE INTO bookmarks
            (uri, did, rkey, cid, subject, created_at, tags,
             enriched_title, enriched_description, enriched_favicon, enriched_image,
             pending_echo, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
    args: [
      r.uri,
      DID,
      rkey,
      r.cid,
      str(v, "subject") ?? "",
      str(v, "createdAt") ?? "",
      JSON.stringify(arr(v["tags"])),
      str(enriched, "title") ?? str(v, "title") ?? null,
      str(enriched, "description") ?? null,
      str(enriched, "favicon") ?? null,
      str(enriched, "image") ?? null,
      now,
    ],
  });
}
console.log(`Upserted ${bookmarks.length} bookmarks`);

// --- step 3: backfill annotations (both collections) -------------------

console.log("Fetching annotations…");
const [kipclipAnnotations, legacyAnnotations] = await Promise.all([
  listAll(PDS_URL, DID, "com.kipclip.annotation"),
  listAll(PDS_URL, DID, "app.bookmark.annotation"),
]);
const allAnnotations = [...kipclipAnnotations, ...legacyAnnotations];
console.log(
  `  → ${kipclipAnnotations.length} com.kipclip.annotation + ${legacyAnnotations.length} app.bookmark.annotation`,
);

for (const r of allAnnotations) {
  const rkey = r.uri.split("/").pop() ?? "";
  const v = r.value ?? {};
  await db.execute({
    sql: `INSERT OR REPLACE INTO annotations
            (uri, did, rkey, cid, subject, title, description, favicon, image, note, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      r.uri,
      DID,
      rkey,
      r.cid,
      str(v, "subject") ?? "",
      str(v, "title") ?? null,
      str(v, "description") ?? null,
      str(v, "favicon") ?? null,
      str(v, "image") ?? null,
      str(v, "note") ?? null,
      now,
    ],
  });
}
console.log(`Upserted ${allAnnotations.length} annotations`);

// --- step 4: backfill tags ---------------------------------------------

console.log("Fetching tags…");
const tags = await listAll(PDS_URL, DID, "com.kipclip.tag");
console.log(`  → ${tags.length} tags`);

for (const r of tags) {
  const rkey = r.uri.split("/").pop() ?? "";
  const v = r.value ?? {};
  await db.execute({
    sql: `INSERT OR REPLACE INTO tags
            (uri, did, rkey, cid, value, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)`,
    args: [
      r.uri,
      DID,
      rkey,
      r.cid,
      str(v, "value") ?? "",
      str(v, "createdAt") ?? "",
      now,
    ],
  });
}
console.log(`Upserted ${tags.length} tags`);

// --- step 5: backfill preferences --------------------------------------

console.log("Fetching preferences…");
const prefs = await listAll(PDS_URL, DID, "com.kipclip.preferences");
console.log(`  → ${prefs.length} preferences records`);

for (const r of prefs) {
  const v = r.value ?? {};
  await db.execute({
    sql: `INSERT OR REPLACE INTO preferences
            (did, cid, date_format, reading_list_tag, updated_at)
          VALUES (?, ?, ?, ?, ?)`,
    args: [
      DID,
      r.cid,
      str(v, "dateFormat") ?? null,
      str(v, "readingListTag") ?? null,
      now,
    ],
  });
}
console.log(`Upserted ${prefs.length} preferences`);

// --- step 6: stamp backfill_complete_at --------------------------------

await db.execute({
  sql: `UPDATE tracked_dids SET backfill_complete_at = ? WHERE did = ?`,
  args: [now, DID],
});
console.log("backfill_complete_at stamped — mirror gate open");

// --- summary -----------------------------------------------------------

const counts = await db.execute(
  `SELECT
    (SELECT COUNT(*) FROM bookmarks WHERE did = '${DID}') AS bookmarks,
    (SELECT COUNT(*) FROM annotations WHERE did = '${DID}') AS annotations,
    (SELECT COUNT(*) FROM tags WHERE did = '${DID}') AS tags`,
);
const row = counts.rows[0] as any;
console.log(
  `\nMirror verified: ${row.bookmarks} bookmarks, ${row.annotations} annotations, ${row.tags} tags`,
);

db.close();
