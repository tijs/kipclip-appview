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

// Defense-in-depth shared secret between TAP and kipclip. The Caddy
// `respond @hook 403` rule is the primary barrier; this check catches
// drift (e.g., a new vhost block forgetting `import common`).
//
// Auth shape: by design, TAP reuses `TAP_ADMIN_PASSWORD` for outbound
// webhook auth (cmd/tap/webhook_client.go calls `req.SetBasicAuth(
// "admin", adminPassword)`). This is documented in indigo's
// cmd/tap/README.md "Authentication" section. So `TAP_WEBHOOK_SECRET`
// on this side MUST be set to the same value as TAP's
// `TAP_ADMIN_PASSWORD` env var.
//
// We also accept `Authorization: Bearer <secret>` for forward-compat
// in case a future TAP version (or another webhook source) ships with
// a separate outbound-webhook auth header.
//
// Rollout policy: env var unset = check disabled (current behavior
// preserved). Set the secret on both kipclip and TAP simultaneously in
// one maintenance window. Once production has the secret, leave it
// set — the unset path is a phased-rollout convenience, not a
// permanent escape hatch.
//
// Read fresh on every request (not cached at module load) so tests
// can toggle behavior between cases. The env-read cost is sub-µs and
// the webhook path is already DB-bound.
function tapWebhookSecret(): string {
  return Deno.env.get("TAP_WEBHOOK_SECRET")?.trim() ?? "";
}

// Single startup warning so an operator notices a misconfigured prod.
if (tapWebhookSecret().length === 0) {
  console.warn(
    "[webhook] TAP_WEBHOOK_SECRET not set — Authorization-header check disabled. " +
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
  // Auth gate. When TAP_WEBHOOK_SECRET is set, require a matching
  // Authorization header. Two shapes accepted:
  //   - `Basic <base64(admin:<secret>)>` — what TAP sends today
  //     (cmd/tap/webhook_client.go calls req.SetBasicAuth("admin",
  //     adminPassword)).
  //   - `Bearer <secret>` — forward-compat for a future TAP that
  //     decouples outbound webhook auth from admin auth.
  // Empty body on 401 to avoid leaking implementation details to a
  // probing attacker. The body is NOT parsed before this check so an
  // unauthenticated request never touches the JSON parser or the
  // mirror DB.
  const secret = tapWebhookSecret();
  if (secret.length > 0) {
    const authz = req.headers.get("Authorization") ?? "";
    const provided = extractWebhookSecret(authz);
    if (provided === null || !await constantTimeEqual(provided, secret)) {
      return new Response(null, { status: 401 });
    }
  }

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

  if (ackAsync()) {
    // Ack immediately so TAP advances its outbox cursor; process in background.
    // Required during backfill when burst load exceeds TAP's
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

function arrayOfStrings(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string");
}
