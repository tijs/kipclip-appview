/**
 * TAP webhook receiver.
 *
 * TAP delivers ONE event per POST. Returning 2xx acks the event so TAP advances
 * its outbox cursor; non-2xx triggers TAP-side retry with backoff.
 *
 * Payload shape (from cmd/tap/types.go MarshallableEvt):
 *   {
 *     "id": <uint>,
 *     "type": "record" | "identity",
 *     "record": { live, did, rev, collection, rkey, action, record, cid }
 *     "identity": { did, handle, is_active, status }
 *   }
 *
 * Idempotent: every upsert keys on URI and uses ON CONFLICT(uri) DO UPDATE.
 * Duplicate redelivery is a no-op count-wise; ON CONFLICT replays the same row.
 */

import { captureError } from "../lib/sentry.ts";
import {
  deleteAnnotation,
  deleteBookmark,
  deletePreferences,
  deleteTag,
  gcSeenWebhookEvents,
  markWebhookEventSeen,
  upsertAnnotation,
  upsertBookmark,
  upsertPreferences,
  upsertTag,
  upsertTrackedDid,
} from "../mirror/upserts.ts";

const BOOKMARK_COLLECTION = "community.lexicon.bookmarks.bookmark";
const ANNOTATION_COLLECTIONS = new Set([
  "app.bookmark.annotation",
  "com.kipclip.annotation",
]);
const TAG_COLLECTION = "com.kipclip.tag";
const PREFERENCES_COLLECTION = "com.kipclip.preferences";

interface RecordEvt {
  live?: boolean;
  did: string;
  rev?: string;
  collection: string;
  rkey: string;
  action: "create" | "update" | "delete" | string;
  record?: Record<string, unknown>;
  cid?: string;
}

interface IdentityEvt {
  did: string;
  handle?: string;
  is_active?: boolean;
  status?: string;
}

interface MarshallableEvt {
  id?: number;
  type: "record" | "identity" | string;
  record?: RecordEvt;
  identity?: IdentityEvt;
}

export interface WebhookResult {
  id?: number;
  type?: string;
  applied: boolean;
  replayed?: boolean;
}

const ACK_ASYNC = Deno.env.get("MIRROR_WEBHOOK_ACK_ASYNC") === "1";

// Opportunistic GC at module load. Process restart on every release swap
// gives this a free trigger; under steady webhook traffic the table
// would otherwise grow unbounded.
gcSeenWebhookEvents().catch((err) => {
  console.warn("[webhook] startup gc failed (non-fatal):", err);
});

export async function handleWebhookRequest(req: Request): Promise<Response> {
  let body: MarshallableEvt;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  // Replay protection. TAP assigns a monotonically-increasing id per
  // outbox event. If we've seen this id before, return 200 immediately
  // without re-running the event — replaying a delete after the user
  // re-created the record would otherwise silently re-delete it. Events
  // without an id (TAP shouldn't send these, but be defensive) bypass
  // dedup and rely on the idempotent upsert layer alone.
  if (typeof body.id === "number") {
    const firstTime = await markWebhookEventSeen(body.id);
    if (!firstTime) {
      return Response.json({
        id: body.id,
        type: body.type,
        applied: false,
        replayed: true,
      });
    }
  }

  if (ACK_ASYNC) {
    // Ack immediately so TAP advances its outbox cursor; process in background.
    // Required during backfill when burst load + Turso latency exceeds TAP's
    // 30s webhook timeout. Idempotent upserts make at-least-once writes safe;
    // event loss on Deno crash is acceptable since owner can re-track.
    queueMicrotask(() => {
      processEvent(body).catch((err) => {
        console.error("[webhook] async dispatch error", err);
        captureError(err as Error, { event: body });
      });
    });
    return Response.json({ id: body.id, type: body.type, applied: true });
  }

  try {
    const result = await processEvent(body);
    return Response.json(result);
  } catch (err) {
    console.error("[webhook] dispatch error", err);
    captureError(err as Error, { event: body });
    // Return 500 so TAP retries the event with backoff.
    return Response.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}

export async function processEvent(
  evt: MarshallableEvt,
): Promise<WebhookResult> {
  if (evt.type === "record" && evt.record) {
    await processRecordEvent(evt.record);
    return { id: evt.id, type: "record", applied: true };
  }
  if (evt.type === "identity" && evt.identity) {
    await processIdentityEvent(evt.identity);
    return { id: evt.id, type: "identity", applied: true };
  }
  return { id: evt.id, type: evt.type, applied: false };
}

async function processRecordEvent(r: RecordEvt): Promise<void> {
  const { did, collection, rkey, action, cid, record } = r;
  if (!did?.startsWith("did:")) throw new Error(`Invalid did: ${did}`);
  if (!collection || !rkey) return;

  const uri = `at://${did}/${collection}/${rkey}`;

  if (action === "delete") {
    if (collection === BOOKMARK_COLLECTION) {
      await deleteBookmark(uri, did);
    } else if (ANNOTATION_COLLECTIONS.has(collection)) {
      await deleteAnnotation(uri, did);
    } else if (collection === TAG_COLLECTION) {
      await deleteTag(uri, did);
    } else if (collection === PREFERENCES_COLLECTION) {
      await deletePreferences(did);
    }
    await touchTracked(did, r);
    return;
  }

  if (action !== "create" && action !== "update") return;
  if (!cid || !record) return;

  if (collection === BOOKMARK_COLLECTION) {
    const subject = stringField(record, "subject");
    const createdAt = stringField(record, "createdAt");
    if (!subject || !createdAt) return;
    const tags = arrayOfStrings(record["tags"]);
    const enriched =
      (record["$enriched"] as Record<string, unknown> | undefined) ??
        {};
    await upsertBookmark({
      uri,
      did,
      rkey,
      cid,
      subject,
      createdAt,
      tags,
      enrichedTitle: stringField(enriched, "title") ??
        stringField(record, "title"),
      enrichedDescription: stringField(enriched, "description"),
      enrichedFavicon: stringField(enriched, "favicon"),
      enrichedImage: stringField(enriched, "image"),
    });
  } else if (ANNOTATION_COLLECTIONS.has(collection)) {
    const subject = stringField(record, "subject");
    if (!subject) return;
    await upsertAnnotation({
      uri,
      did,
      rkey,
      cid,
      subject,
      title: stringField(record, "title"),
      description: stringField(record, "description"),
      favicon: stringField(record, "favicon"),
      image: stringField(record, "image"),
      note: stringField(record, "note"),
    });
  } else if (collection === TAG_COLLECTION) {
    const value = stringField(record, "value");
    const createdAt = stringField(record, "createdAt");
    if (!value || !createdAt) return;
    await upsertTag({
      uri,
      did,
      rkey,
      cid,
      value,
      createdAt,
    });
  } else if (collection === PREFERENCES_COLLECTION) {
    await upsertPreferences({
      did,
      cid,
      dateFormat: stringField(record, "dateFormat"),
      readingListTag: stringField(record, "readingListTag"),
    });
  }

  await touchTracked(did, r);
}

async function processIdentityEvent(_e: IdentityEvt): Promise<void> {
  // Identity events not consumed yet. Phase 2+ may use handle/status to refresh
  // a local cache. For now no-op so TAP can ack.
}

async function touchTracked(did: string, r: RecordEvt): Promise<void> {
  const now = Date.now();
  // On the first live event we set BOTH started + complete so the row never has
  // complete-without-started (which would fail the mirror-read gate that
  // requires backfill_started_at !== null). Existing non-null values are
  // preserved by upsertTrackedDid's COALESCE clauses.
  await upsertTrackedDid({
    did,
    lastEventAt: now,
    backfillStartedAt: r.live ? now : null,
    backfillCompleteAt: r.live ? now : null,
  });
}

function stringField(
  obj: Record<string, unknown> | undefined,
  key: string,
): string | null {
  if (!obj) return null;
  const v = obj[key];
  return typeof v === "string" ? v : null;
}

function arrayOfStrings(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string");
}
