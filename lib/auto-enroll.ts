/**
 * Background auto-enrollment for new users.
 *
 * Triggered fire-and-forget from /api/initial-data on first request by an
 * untracked DID. Runs the full PDS backfill, then inserts the tracked_dids
 * row with BOTH timestamps set atomically so the user never sees a "syncing"
 * state with 0 bookmarks — the mirror gate opens only after data is ready.
 */

import {
  upsertAnnotation,
  upsertBookmark,
  upsertPreferences,
  upsertTag,
} from "../mirror/upserts.ts";
import { mirrorWrite } from "./db.ts";
import { getMirrorMode } from "./mirror-config.ts";
import { captureMessage } from "./sentry.ts";

const TAP_CONTROL_URL = Deno.env.get("TAP_CONTROL_URL") ??
  "http://127.0.0.1:2480";
const TAP_ADMIN_PASSWORD = Deno.env.get("TAP_ADMIN_PASSWORD");

// Prevents concurrent enrollment attempts for the same DID within one
// server process lifetime. A second request during the background run is a
// no-op; the DID gets tracked before the next login cycle completes.
const enrollingDids = new Set<string>();

async function listAll(
  pdsUrl: string,
  did: string,
  collection: string,
): Promise<any[]> {
  const records: any[] = [];
  let cursor: string | undefined;
  while (true) {
    const url = new URL(`${pdsUrl}/xrpc/com.atproto.repo.listRecords`);
    url.searchParams.set("repo", did);
    url.searchParams.set("collection", collection);
    url.searchParams.set("limit", "100");
    if (cursor) url.searchParams.set("cursor", cursor);
    const res = await fetch(url.toString());
    if (!res.ok) {
      throw new Error(`listRecords ${collection}: ${res.status}`);
    }
    const data = await res.json();
    const batch: any[] = data.records ?? [];
    records.push(...batch);
    cursor = data.cursor;
    if (!cursor || batch.length === 0) break;
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

async function tapEnroll(did: string): Promise<void> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (TAP_ADMIN_PASSWORD) {
    headers.Authorization = "Basic " + btoa(`admin:${TAP_ADMIN_PASSWORD}`);
  }
  const r = await fetch(`${TAP_CONTROL_URL}/repos/add`, {
    method: "POST",
    headers,
    body: JSON.stringify({ dids: [did] }),
  });
  if (!r.ok) throw new Error(`TAP /repos/add returned ${r.status}`);
}

async function runBackfill(did: string, pdsUrl: string): Promise<void> {
  const [bookmarks, kipclipAnnotations, legacyAnnotations, tags, prefs] =
    await Promise.all([
      listAll(pdsUrl, did, "community.lexicon.bookmarks.bookmark"),
      listAll(pdsUrl, did, "com.kipclip.annotation"),
      listAll(pdsUrl, did, "app.bookmark.annotation"),
      listAll(pdsUrl, did, "com.kipclip.tag"),
      listAll(pdsUrl, did, "com.kipclip.preferences"),
    ]);

  for (const r of bookmarks) {
    const rkey = r.uri.split("/").pop() ?? "";
    const v = r.value ?? {};
    const enriched = (v["$enriched"] as Record<string, unknown>) ?? {};
    await upsertBookmark({
      uri: r.uri,
      did,
      rkey,
      cid: r.cid,
      subject: str(v, "subject") ?? "",
      createdAt: str(v, "createdAt") ?? "",
      tags: arr(v["tags"]),
      enrichedTitle: str(enriched, "title") ?? str(v, "title") ?? null,
      enrichedDescription: str(enriched, "description") ?? null,
      enrichedFavicon: str(enriched, "favicon") ?? null,
      enrichedImage: str(enriched, "image") ?? null,
    });
  }

  for (const r of [...kipclipAnnotations, ...legacyAnnotations]) {
    const rkey = r.uri.split("/").pop() ?? "";
    const v = r.value ?? {};
    await upsertAnnotation({
      uri: r.uri,
      did,
      rkey,
      cid: r.cid,
      subject: str(v, "subject") ?? "",
      title: str(v, "title") ?? null,
      description: str(v, "description") ?? null,
      favicon: str(v, "favicon") ?? null,
      image: str(v, "image") ?? null,
      note: str(v, "note") ?? null,
    });
  }

  for (const r of tags) {
    const rkey = r.uri.split("/").pop() ?? "";
    const v = r.value ?? {};
    await upsertTag({
      uri: r.uri,
      did,
      rkey,
      cid: r.cid,
      value: str(v, "value") ?? "",
      createdAt: str(v, "createdAt") ?? "",
    });
  }

  for (const r of prefs) {
    const v = r.value ?? {};
    await upsertPreferences({
      did,
      cid: r.cid,
      dateFormat: str(v, "dateFormat") ?? null,
      readingListTag: str(v, "readingListTag") ?? null,
    });
  }
}

/**
 * Fire-and-forget. Call from request handlers with no await.
 * Safe to call multiple times — the enrollingDids Set prevents duplicates.
 */
export function autoEnrollIfNeeded(did: string, pdsUrl: string): void {
  if (getMirrorMode() !== "read") return;
  if (enrollingDids.has(did)) return;
  enrollingDids.add(did);

  (async () => {
    try {
      console.log(`[auto-enroll] starting for ${did}`);

      await tapEnroll(did).catch((err) =>
        console.warn(`[auto-enroll] TAP enroll failed (non-fatal): ${err}`)
      );

      await runBackfill(did, pdsUrl);

      const now = Date.now();
      await mirrorWrite({
        sql: `
          INSERT INTO tracked_dids
            (did, pds_url, added_at, backfill_started_at, backfill_complete_at, last_seq, last_event_at)
          VALUES (?, ?, ?, ?, ?, NULL, NULL)
          ON CONFLICT(did) DO UPDATE SET
            pds_url = COALESCE(tracked_dids.pds_url, excluded.pds_url),
            backfill_started_at = COALESCE(tracked_dids.backfill_started_at, excluded.backfill_started_at),
            backfill_complete_at = COALESCE(tracked_dids.backfill_complete_at, excluded.backfill_complete_at)
        `,
        args: [did, pdsUrl, now, now, now],
      });

      console.log(`[auto-enroll] complete for ${did}`);
    } catch (err) {
      enrollingDids.delete(did);
      captureMessage("auto-enroll failed", "error", {
        did,
        error: String(err),
      });
      console.error(`[auto-enroll] failed for ${did}:`, err);
    }
  })();
}
