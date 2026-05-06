/**
 * Shared utilities for route handlers.
 */

import { getClearSessionCookie, getSessionFromRequest } from "./session.ts";
import { tagIncludes } from "../shared/tag-utils.ts";
import { shouldReadFromMirror } from "./mirror-config.ts";
import {
  getAnnotation,
  getBookmark,
  getTag,
  listAllBookmarks,
  listTags,
} from "../mirror/queries.ts";
import { captureMessage } from "./sentry.ts";

/** AT Protocol collection names */
export const BOOKMARK_COLLECTION = "community.lexicon.bookmarks.bookmark";
export const TAG_COLLECTION = "com.kipclip.tag";
export const ANNOTATION_COLLECTION = "com.kipclip.annotation";
export const PREFERENCES_COLLECTION = "com.kipclip.preferences";

/** OAuth scopes - granular permissions for only the collections kipclip uses */
export const OAUTH_SCOPES = "atproto " +
  "repo:community.lexicon.bookmarks.bookmark?action=create " +
  "repo:community.lexicon.bookmarks.bookmark?action=read " +
  "repo:community.lexicon.bookmarks.bookmark?action=update " +
  "repo:community.lexicon.bookmarks.bookmark?action=delete " +
  "repo:com.kipclip.tag?action=create " +
  "repo:com.kipclip.tag?action=read " +
  "repo:com.kipclip.tag?action=update " +
  "repo:com.kipclip.tag?action=delete " +
  "repo:com.kipclip.annotation?action=create " +
  "repo:com.kipclip.annotation?action=read " +
  "repo:com.kipclip.annotation?action=update " +
  "repo:com.kipclip.annotation?action=delete " +
  "repo:com.kipclip.preferences?action=create " +
  "repo:com.kipclip.preferences?action=read " +
  "repo:com.kipclip.preferences?action=update";

/**
 * Set the session cookie header on a response if provided.
 */
export function setSessionCookie(
  response: Response,
  setCookieHeader: string | undefined,
): Response {
  if (setCookieHeader) {
    response.headers.set("Set-Cookie", setCookieHeader);
  }
  return response;
}

/**
 * Create a 401 response for unauthenticated requests.
 */
export function createAuthErrorResponse(error?: {
  message?: string;
  type?: string;
}): Response {
  const response = Response.json(
    {
      error: "Authentication required",
      message: error?.message || "Please log in again",
      code: error?.type || "SESSION_EXPIRED",
    },
    { status: 401 },
  );
  response.headers.set("Set-Cookie", getClearSessionCookie());
  return response;
}

/**
 * Helper to get session and return auth error if not authenticated.
 * Returns null if not authenticated (response already sent).
 */
export async function requireAuth(request: Request): Promise<
  {
    session: Awaited<ReturnType<typeof getSessionFromRequest>>["session"];
    setCookieHeader: string | undefined;
  } | null
> {
  const result = await getSessionFromRequest(request);
  if (!result.session) {
    return null;
  }
  return {
    session: result.session,
    setCookieHeader: result.setCookieHeader,
  };
}

/**
 * Create PDS tag records for tags that don't already exist.
 * Comparison is case-insensitive — "swift" won't create a new record if "Swift" exists.
 * Optionally pass pre-fetched tag records to avoid a redundant listRecords call.
 */
export async function createNewTagRecords(
  oauthSession: any,
  tags: string[],
  existingRecords?: any[],
): Promise<void> {
  const records = existingRecords ??
    await listAllRecords(oauthSession, TAG_COLLECTION);
  const existingTagValues: string[] = records.map((rec: any) =>
    rec.value?.value
  ).filter(Boolean);
  const newTags = tags.filter((t) => !tagIncludes(existingTagValues, t));
  await Promise.all(newTags.map((tagValue) =>
    oauthSession.makeRequest(
      "POST",
      `${oauthSession.pdsUrl}/xrpc/com.atproto.repo.createRecord`,
      {
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          repo: oauthSession.did,
          collection: TAG_COLLECTION,
          record: { value: tagValue, createdAt: new Date().toISOString() },
        }),
      },
    ).catch((err: any) =>
      console.error(`Failed to create tag "${tagValue}":`, err)
    )
  ));
}

/** Rate limit info from PDS response headers */
export interface RateLimitInfo {
  remaining: number;
  reset: number;
  limit: number;
}

/** Extract rate limit info from a PDS response */
function parseRateLimit(res: Response): RateLimitInfo | undefined {
  const remaining = parseInt(
    res.headers.get("ratelimit-remaining") ?? "",
    10,
  );
  if (Number.isNaN(remaining)) return undefined;
  return {
    remaining,
    reset: parseInt(res.headers.get("ratelimit-reset") || "0", 10) || 0,
    limit: parseInt(res.headers.get("ratelimit-limit") || "3000", 10) || 3000,
  };
}

/**
 * Fetch a single page of records from an AT Protocol collection.
 * Returns records and an optional cursor for the next page.
 */
export async function listOnePage(
  oauthSession: any,
  collection: string,
  options?: { cursor?: string; reverse?: boolean; limit?: number },
): Promise<{ records: any[]; cursor?: string; rateLimit?: RateLimitInfo }> {
  const params = new URLSearchParams({
    repo: oauthSession.did,
    collection,
    limit: String(options?.limit ?? 100),
  });
  if (options?.cursor) params.set("cursor", options.cursor);
  if (options?.reverse) params.set("reverse", "true");

  const res = await oauthSession.makeRequest(
    "GET",
    `${oauthSession.pdsUrl}/xrpc/com.atproto.repo.listRecords?${params}`,
  );
  if (!res.ok) return { records: [] };

  const rateLimit = parseRateLimit(res);
  const data = await res.json();
  return {
    records: data.records || [],
    cursor: data.cursor || undefined,
    rateLimit,
  };
}

/**
 * Paginate through all records in an AT Protocol collection.
 * Returns every record, following cursors until exhausted.
 */
export async function listAllRecords(
  oauthSession: any,
  collection: string,
): Promise<any[]> {
  const all: any[] = [];
  let cursor: string | undefined;

  do {
    const params = new URLSearchParams({
      repo: oauthSession.did,
      collection,
      limit: "100",
    });
    if (cursor) params.set("cursor", cursor);

    const res = await oauthSession.makeRequest(
      "GET",
      `${oauthSession.pdsUrl}/xrpc/com.atproto.repo.listRecords?${params}`,
    );
    if (!res.ok) break;

    const data = await res.json();
    all.push(...(data.records || []));
    cursor = data.cursor;
  } while (cursor);

  return all;
}

/**
 * Mirror-aware bookmark records for the session's owner DID.
 *
 * Returns records in the same shape as `listAllRecords(session, BOOKMARK_COLLECTION)`
 * so existing call sites swap in without downstream changes:
 *   `{uri, cid, value: {subject, createdAt, tags}}[]`
 *
 * Behavior:
 *   - Tracked DID + MIRROR_MODE=read: serve from mirror. Mirror is authoritative;
 *     empty result is returned as `[]` (does NOT fall through to PDS).
 *   - Tracked DID + Turso failure: capture warning to Sentry and fall through to PDS.
 *   - Untracked DID / MIRROR_MODE=off: PDS path unchanged.
 *   - `forcePds: true`: bypass mirror entirely (for migration scripts that need raw PDS).
 */
export async function fetchOwnerBookmarkRecords(
  oauthSession: any,
  opts?: { forcePds?: boolean },
): Promise<any[]> {
  if (opts?.forcePds) {
    return await listAllRecords(oauthSession, BOOKMARK_COLLECTION);
  }
  const decision = await shouldReadFromMirror(oauthSession.did);
  if (decision.fromMirror) {
    try {
      const bookmarks = await listAllBookmarks(oauthSession.did);
      return bookmarks.map((b) => ({
        uri: b.uri,
        cid: b.cid,
        value: {
          subject: b.subject,
          createdAt: b.createdAt,
          tags: b.tags,
        },
      }));
    } catch (err) {
      captureMessage(
        "mirror read fallback to PDS",
        "warning",
        {
          did: oauthSession.did,
          op: "fetchOwnerBookmarkRecords",
          error: String(err),
        },
      );
    }
  }
  return await listAllRecords(oauthSession, BOOKMARK_COLLECTION);
}

/**
 * Mirror-aware tag records for the session's owner DID.
 *
 * Returns records shaped like `listAllRecords(session, TAG_COLLECTION)`:
 *   `{uri, cid, value: {value, createdAt}}[]`
 *
 * Same semantics as `fetchOwnerBookmarkRecords` for mirror-vs-PDS branching.
 */
export async function fetchOwnerTagRecords(
  oauthSession: any,
  opts?: { forcePds?: boolean },
): Promise<any[]> {
  if (opts?.forcePds) {
    return await listAllRecords(oauthSession, TAG_COLLECTION);
  }
  const decision = await shouldReadFromMirror(oauthSession.did);
  if (decision.fromMirror) {
    try {
      const tags = await listTags(oauthSession.did);
      return tags.map((t) => ({
        uri: t.uri,
        cid: t.cid,
        value: {
          value: t.value,
          createdAt: t.createdAt,
        },
      }));
    } catch (err) {
      captureMessage(
        "mirror read fallback to PDS",
        "warning",
        {
          did: oauthSession.did,
          op: "fetchOwnerTagRecords",
          error: String(err),
        },
      );
    }
  }
  return await listAllRecords(oauthSession, TAG_COLLECTION);
}

/**
 * Mirror-aware single-record fetch, shaped like a PDS `getRecord` response:
 *   `{uri, cid, value}`
 *
 * Behavior matches the list-shape helpers above except for one key
 * difference: a mirror MISS (row not present) falls through to PDS rather
 * than returning null. Single-record reads are typically read-before-write
 * paths (PUT bookmark, PUT/DELETE tag, refresh metadata) and a sync-gap
 * miss should not 404 a record the user can edit. Steady-state mirror hit
 * still drops PDS reads to zero.
 *
 * Returns `null` when the record genuinely does not exist (PDS 404).
 */
async function pdsGetRecord(
  oauthSession: any,
  collection: string,
  rkey: string,
): Promise<{ uri: string; cid: string; value: any } | null> {
  const params = new URLSearchParams({
    repo: oauthSession.did,
    collection,
    rkey,
  });
  const res = await oauthSession.makeRequest(
    "GET",
    `${oauthSession.pdsUrl}/xrpc/com.atproto.repo.getRecord?${params}`,
  );
  if (!res.ok) {
    if (res.status === 404) return null;
    const errorText = await res.text();
    throw new Error(`getRecord ${collection}/${rkey} failed: ${errorText}`);
  }
  return await res.json();
}

export async function fetchOwnerBookmarkRecord(
  oauthSession: any,
  rkey: string,
): Promise<{ uri: string; cid: string; value: any } | null> {
  const decision = await shouldReadFromMirror(oauthSession.did);
  if (decision.fromMirror) {
    try {
      const uri = `at://${oauthSession.did}/${BOOKMARK_COLLECTION}/${rkey}`;
      const b = await getBookmark(uri);
      if (b) {
        return {
          uri: b.uri,
          cid: b.cid,
          value: {
            subject: b.subject,
            createdAt: b.createdAt,
            tags: b.tags,
          },
        };
      }
    } catch (err) {
      captureMessage(
        "mirror read fallback to PDS",
        "warning",
        {
          did: oauthSession.did,
          op: "fetchOwnerBookmarkRecord",
          error: String(err),
        },
      );
    }
  }
  return await pdsGetRecord(oauthSession, BOOKMARK_COLLECTION, rkey);
}

export async function fetchOwnerTagRecord(
  oauthSession: any,
  rkey: string,
): Promise<{ uri: string; cid: string; value: any } | null> {
  const decision = await shouldReadFromMirror(oauthSession.did);
  if (decision.fromMirror) {
    try {
      const uri = `at://${oauthSession.did}/${TAG_COLLECTION}/${rkey}`;
      const t = await getTag(uri);
      if (t) {
        return {
          uri: t.uri,
          cid: t.cid,
          value: {
            value: t.value,
            createdAt: t.createdAt,
          },
        };
      }
    } catch (err) {
      captureMessage(
        "mirror read fallback to PDS",
        "warning",
        {
          did: oauthSession.did,
          op: "fetchOwnerTagRecord",
          error: String(err),
        },
      );
    }
  }
  return await pdsGetRecord(oauthSession, TAG_COLLECTION, rkey);
}

export async function fetchOwnerAnnotationRecord(
  oauthSession: any,
  rkey: string,
): Promise<{ uri: string; cid: string; value: any } | null> {
  const decision = await shouldReadFromMirror(oauthSession.did);
  if (decision.fromMirror) {
    try {
      const uri = `at://${oauthSession.did}/${ANNOTATION_COLLECTION}/${rkey}`;
      const a = await getAnnotation(uri);
      if (a) {
        return {
          uri: a.uri,
          cid: a.cid,
          value: {
            subject: a.subject,
            title: a.title ?? undefined,
            description: a.description ?? undefined,
            favicon: a.favicon ?? undefined,
            image: a.image ?? undefined,
            note: a.note ?? undefined,
          },
        };
      }
    } catch (err) {
      captureMessage(
        "mirror read fallback to PDS",
        "warning",
        {
          did: oauthSession.did,
          op: "fetchOwnerAnnotationRecord",
          error: String(err),
        },
      );
    }
  }
  return await pdsGetRecord(oauthSession, ANNOTATION_COLLECTION, rkey);
}

/** Re-export for convenience */
export { getClearSessionCookie, getSessionFromRequest };
