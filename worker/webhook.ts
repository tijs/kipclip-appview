/**
 * TAP webhook receiver.
 *
 * Parses TAP event batches and routes to mirror upserts/deletes. Idempotent
 * via the upsert layer's ON CONFLICT(uri) DO UPDATE rule, so duplicate
 * redelivery is safe.
 *
 * Event schema is TAP-version-dependent and not finalised at plan time
 * (see Open Questions → Deferred to Implementation in
 * docs/plans/2026-05-02-001-feat-appview-mirror-phases-0-2-plan.md). This
 * implementation models it after the AT Proto firehose shape and may need
 * adjustment after the U10 install spike confirms the actual payload.
 *
 * Expected shape:
 *   {
 *     "events": [
 *       {
 *         "type": "commit",
 *         "repo": "did:plc:...",
 *         "seq": 42,
 *         "time": "2026-05-02T12:00:00Z",
 *         "ops": [
 *           { "action": "create"|"update"|"delete",
 *             "path": "collection/rkey",
 *             "cid": "bafy...",
 *             "record": { ... }     // omitted for delete
 *           }
 *         ]
 *       },
 *       { "type": "backfill_complete", "repo": "did:plc:..." }
 *     ]
 *   }
 */

import { captureError } from "../lib/sentry.ts";
import {
  deleteAnnotation,
  deleteBookmark,
  deleteTag,
  upsertAnnotation,
  upsertBookmark,
  upsertTag,
  upsertTrackedDid,
} from "../mirror/upserts.ts";

const BOOKMARK_COLLECTION = "community.lexicon.bookmarks.bookmark";
const ANNOTATION_COLLECTIONS = new Set([
  "app.bookmark.annotation",
  "com.kipclip.annotation",
]);
const TAG_COLLECTION = "com.kipclip.tag";

interface CommitOp {
  action?: string;
  path?: string;
  cid?: string;
  record?: Record<string, unknown>;
}

interface CommitEvent {
  type: "commit";
  repo: string;
  seq?: number;
  time?: string;
  ops?: CommitOp[];
}

interface BackfillCompleteEvent {
  type: "backfill_complete";
  repo: string;
}

type Event = CommitEvent | BackfillCompleteEvent | { type: string; [k: string]: unknown };

export interface WebhookResult {
  received: number;
  applied: number;
  errors: number;
}

export async function handleWebhookRequest(req: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const events = Array.isArray((body as { events?: unknown[] })?.events)
    ? (body as { events: Event[] }).events
    : [];

  const result = await processEvents(events);
  return Response.json(result);
}

export async function processEvents(events: Event[]): Promise<WebhookResult> {
  let applied = 0;
  let errors = 0;

  for (const event of events) {
    try {
      if (event.type === "commit") {
        await processCommit(event as CommitEvent);
        applied++;
      } else if (event.type === "backfill_complete") {
        await upsertTrackedDid({
          did: (event as BackfillCompleteEvent).repo,
          backfillCompleteAt: Date.now(),
        });
        applied++;
      }
    } catch (err) {
      errors++;
      console.error("[webhook] event error", err);
      captureError(err as Error, { event });
    }
  }

  return { received: events.length, applied, errors };
}

async function processCommit(event: CommitEvent): Promise<void> {
  const did = event.repo;
  if (typeof did !== "string" || !did.startsWith("did:")) {
    throw new Error(`Invalid repo DID: ${did}`);
  }

  const ops = event.ops ?? [];
  const eventTime = event.time ? Date.parse(event.time) : NaN;
  const eventAt = Number.isFinite(eventTime) ? eventTime : Date.now();

  for (const op of ops) {
    await processOp(did, op);
  }

  await upsertTrackedDid({
    did,
    lastSeq: typeof event.seq === "number" ? event.seq : null,
    lastEventAt: eventAt,
  });
}

async function processOp(did: string, op: CommitOp): Promise<void> {
  if (!op.path) return;
  const slashIdx = op.path.indexOf("/");
  if (slashIdx <= 0) return;

  const collection = op.path.slice(0, slashIdx);
  const rkey = op.path.slice(slashIdx + 1);
  if (!rkey) return;

  const uri = `at://${did}/${collection}/${rkey}`;

  if (op.action === "delete") {
    if (collection === BOOKMARK_COLLECTION) {
      await deleteBookmark(uri, did);
    } else if (ANNOTATION_COLLECTIONS.has(collection)) {
      await deleteAnnotation(uri, did);
    } else if (collection === TAG_COLLECTION) {
      await deleteTag(uri, did);
    }
    return;
  }

  if (op.action !== "create" && op.action !== "update") return;
  if (!op.cid || !op.record) return;
  const record = op.record;

  if (collection === BOOKMARK_COLLECTION) {
    const subject = stringField(record, "subject");
    const createdAt = stringField(record, "createdAt");
    if (!subject || !createdAt) return;
    const tags = arrayOfStrings(record["tags"]);
    const enriched = (record["$enriched"] as Record<string, unknown> | undefined) ?? {};
    await upsertBookmark({
      uri,
      did,
      rkey,
      cid: op.cid,
      subject,
      createdAt,
      tags,
      enrichedTitle: stringField(enriched, "title") ??
        stringField(record, "title"),
      enrichedDescription: stringField(enriched, "description"),
      enrichedFavicon: stringField(enriched, "favicon"),
      enrichedImage: stringField(enriched, "image"),
    });
    return;
  }

  if (ANNOTATION_COLLECTIONS.has(collection)) {
    const subject = stringField(record, "subject");
    if (!subject) return;
    await upsertAnnotation({
      uri,
      did,
      rkey,
      cid: op.cid,
      subject,
      title: stringField(record, "title"),
      description: stringField(record, "description"),
      favicon: stringField(record, "favicon"),
      image: stringField(record, "image"),
      note: stringField(record, "note"),
    });
    return;
  }

  if (collection === TAG_COLLECTION) {
    const value = stringField(record, "value");
    const createdAt = stringField(record, "createdAt");
    if (!value || !createdAt) return;
    await upsertTag({
      uri,
      did,
      rkey,
      cid: op.cid,
      value,
      createdAt,
    });
    return;
  }
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
