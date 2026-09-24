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
import { db } from "../lib/db.ts";
import {
  classifyMalformedEvent,
  sanitizeLogToken,
  summarizeEvent,
} from "../lib/webhook-diag.ts";
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
} from "../mirror/upserts.ts";
import { broadcastToDid } from "../routes/api/live.ts";
import { isUsableAnnotationRecord } from "../lib/preview-enrichment-jobs.ts";

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

// Read fresh per-request (not cached at module load) so tests can toggle the
// flag between cases. Sub-µs cost; this is a DB-bound path.
function ackAsync(): boolean {
  return Deno.env.get("MIRROR_WEBHOOK_ACK_ASYNC") === "1";
}

async function webhookEventKey(id: number, payload: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(payload)),
  );
  const hash = Array.from(
    digest,
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
  return `${id}:${hash}`;
}

// Defense-in-depth shared secret between TAP and kipclip. The Caddy
// `respond @hook 403` rule is the primary barrier; this check catches
// drift (e.g., a new vhost block forgetting `import common`).
//
// TAP uses Basic auth with username "admin" on all endpoints including
// outbound webhook delivery (cmd/tap/webhook_client.go calls
// `req.SetBasicAuth("admin", adminPassword)`). We also accept
// `Authorization: Bearer <secret>` for forward-compat.
//
// Env var unset = check disabled. Read fresh on every request (not
// cached at module load) so tests can toggle behavior between cases.
function tapAdminPassword(): string {
  return Deno.env.get("TAP_ADMIN_PASSWORD")?.trim() ?? "";
}

// Single startup warning so an operator notices a misconfigured prod.
if (tapAdminPassword().length === 0) {
  console.warn(
    "[webhook] TAP_ADMIN_PASSWORD not set — Authorization-header check disabled. " +
      "Set this env var on production once TAP is sending the matching header.",
  );
}

/**
 * Constant-time equality check for the shared secret. Hashing both
 * sides to fixed-length SHA-256 digests dodges length-leak via
 * short-circuit when inputs differ in length, and the byte-XOR loop
 * runs in constant time relative to input length.
 */
async function constantTimeEqual(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const aHash = new Uint8Array(
    await crypto.subtle.digest("SHA-256", enc.encode(a)),
  );
  const bHash = new Uint8Array(
    await crypto.subtle.digest("SHA-256", enc.encode(b)),
  );
  let diff = 0;
  for (let i = 0; i < aHash.length; i++) diff |= aHash[i] ^ bHash[i];
  return diff === 0;
}

/**
 * Extract the webhook secret from an Authorization header value.
 *
 * - `Bearer <secret>` → returns `<secret>`
 * - `Basic <base64(admin:<secret>)>` → returns `<secret>` when
 *   username is "admin" (matches TAP's webhook_client.go shape).
 *   Other usernames return null so a leaked unrelated Basic-auth
 *   token can't authenticate the webhook.
 * - Anything else → null
 */
function extractWebhookSecret(authz: string): string | null {
  if (authz.startsWith("Bearer ")) {
    const v = authz.slice(7).trim();
    return v.length > 0 ? v : null;
  }
  if (authz.startsWith("Basic ")) {
    let decoded: string;
    try {
      decoded = atob(authz.slice(6).trim());
    } catch {
      return null;
    }
    const sep = decoded.indexOf(":");
    if (sep < 0) return null;
    const user = decoded.slice(0, sep);
    const pass = decoded.slice(sep + 1);
    if (user !== "admin") return null;
    return pass.length > 0 ? pass : null;
  }
  return null;
}

/**
 * Call once after migrations complete. Prunes seen_webhook_events rows older
 * than 7 days; process restart on every release swap gives a free trigger.
 */
export function initWebhook(): void {
  gcSeenWebhookEvents().catch((err) => {
    console.warn("[webhook] startup gc failed (non-fatal):", err);
  });
}

export async function handleWebhookRequest(req: Request): Promise<Response> {
  // Auth gate. When TAP_ADMIN_PASSWORD is set, require a matching
  // Authorization header (Basic admin:<pw> or Bearer <pw>).
  const secret = tapAdminPassword();
  if (secret.length > 0) {
    const authz = req.headers.get("Authorization") ?? "";
    const provided = extractWebhookSecret(authz);
    if (provided === null || !await constantTimeEqual(provided, secret)) {
      return new Response(null, { status: 401 });
    }
  }

  let body: MarshallableEvt;
  let payload: string;
  try {
    payload = await req.text();
    body = JSON.parse(payload);
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  // Replay protection. TAP reuses IDs after a restart when its outbox is
  // empty, so an ID alone is not unique across process lifetimes. Include a
  // payload hash: exact retries deduplicate, while a new event reusing an old
  // ID still applies. Events without an id bypass dedup and rely on the
  // idempotent upsert layer alone.
  if (typeof body.id === "number") {
    const firstTime = await markWebhookEventSeen(
      await webhookEventKey(body.id, payload),
    );
    if (!firstTime) {
      return Response.json({
        id: body.id,
        type: body.type,
        applied: false,
        replayed: true,
      });
    }
  }

  if (ackAsync()) {
    // Ack immediately so TAP advances its outbox cursor; process in background.
    // Required during backfill when burst load exceeds TAP's
    // 30s webhook timeout. Idempotent upserts make at-least-once writes safe;
    // event loss on Deno crash is acceptable since owner can re-track.
    queueMicrotask(() => {
      processEvent(body).catch((err) => {
        console.error(
          "[webhook] async dispatch error",
          err,
          summarizeEvent(body),
        );
        // Bounded diagnostics only — never the raw event payload.
        captureError(err as Error, { event: summarizeEvent(body) });
      });
    });
    return Response.json({ id: body.id, type: body.type, applied: true });
  }

  try {
    const result = await processEvent(body);
    return Response.json(result);
  } catch (err) {
    console.error(
      "[webhook] dispatch error",
      err,
      summarizeEvent(body),
    );
    captureError(err as Error, { event: summarizeEvent(body) });
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
    // processRecordEvent throws on upsert failure → broadcast does not run,
    // and TAP retries the event on the 500.
    await processRecordEvent(evt.record);
    broadcastToDid(evt.record.did, {
      type: "record",
      collection: evt.record.collection,
      rkey: evt.record.rkey,
      op: evt.record.action,
      indexedAt: Date.now(),
    });
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
  if (classifyMalformedEvent({ type: "record", record: r }) === "invalid-did") {
    // Bounded: no raw DID in the exception (it is returned to TAP in the
    // 500 body and lands in journals); classify via the event summary.
    throw new Error("Invalid did in record event");
  }
  if (!collection || !rkey) {
    if (classifyMalformedEvent({ type: "record", record: r }) !== "ok") {
      // Never raw payloads — bounded one-liner, once per shape per process
      // so a misbehaving relay cannot spam the journal.
      logMalformedOnce(r, "record");
    }
    return;
  }

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
    } else {
      logMalformedOnce(r, collection);
    }
    await touchTracked(did, r);
    return;
  }

  if (action !== "create" && action !== "update") {
    logMalformedOnce(r, collection);
    return;
  }
  if (!cid || !record) {
    logMalformedOnce(r, collection);
    return;
  }

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
    // Preview-job settle/cancel semantics: a COMPLETE annotation echo still
    // cancels queued preview work (default clearPreviewJob, as before). An
    // INCOMPLETE echo must NOT erase a pending/failed retry job — e.g. the
    // preview worker's own bounded-retry write when a YouTube watch page had
    // no usable description would otherwise lose its attempts/backoff, and
    // the next 60s scan would re-enqueue an attempts=0 job forever. Judged
    // from the echoed record itself (order-independent of mirror writes)
    // via the same usability predicate the preview system applies.
    const bookmarkUriRows = await db.execute({
      sql: "SELECT subject FROM bookmarks WHERE uri = ? LIMIT 1",
      args: [subject],
    });
    const annotationUsable = isUsableAnnotationRecord({
      subjectUrl: bookmarkUriRows.rows.length > 0
        ? String(bookmarkUriRows.rows[0][0])
        : null,
      title: stringField(record, "title"),
      description: stringField(record, "description"),
      favicon: stringField(record, "favicon"),
      image: stringField(record, "image"),
      note: stringField(record, "note"),
    });
    await upsertAnnotation(
      {
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
      },
      annotationUsable ? undefined : { clearPreviewJob: false },
    );
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
  // UPDATE-only: never insert a new row. Inserting would set backfill_started_at
  // = now which opens the mirror gate for a DID whose mirror is empty — callers
  // would then serve 0 bookmarks instead of falling through to PDS.
  // upsertTrackedDid is intentionally NOT used here.
  //
  // On the first live (post-backfill) event, stamp backfill_complete_at via
  // COALESCE — once stamped it is never regressed. Non-live (backfill replay)
  // events leave backfill_complete_at unchanged so the gate stays closed until
  // live traffic confirms backfill caught up.
  await db.execute({
    sql: `UPDATE tracked_dids
            SET last_event_at = MAX(?, COALESCE(last_event_at, 0)),
                backfill_complete_at = CASE
                  WHEN ? = 1 THEN COALESCE(backfill_complete_at, ?)
                  ELSE backfill_complete_at
                END
          WHERE did = ?`,
    args: [now, r.live ? 1 : 0, now, did],
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

// Per-process dedupe so a misbehaving relay can't spam the journal with
// per-event malformed warnings: one bounded line per (class, sanitized
// bucket). The bucket is creator-controlled collection text — it is
// sanitized (newlines/control chars stripped, length-capped) BEFORE it
// reaches either the dedupe key or the log line, so an attacker cannot
// inject journal lines or grow the Set unboundedly.
const malformedWarned = new Set<string>();

function logMalformedOnce(r: RecordEvt, bucket: string): void {
  const cls = classifyMalformedEvent({ type: "record", record: r });
  const safeBucket = sanitizeLogToken(bucket);
  const key = `${cls}:${safeBucket}`;
  if (malformedWarned.has(key)) return;
  malformedWarned.add(key);
  console.warn(
    `[webhook] dropped malformed record event ${
      summarizeEvent({
        type: "record",
        record: r,
      })
    } bucket=${safeBucket}`,
  );
}

function arrayOfStrings(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string");
}
