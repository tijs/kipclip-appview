/**
 * Shared utilities for route handlers.
 */

import { getClearSessionCookie, getSessionFromRequest } from "./session.ts";
import { tagIncludes } from "../shared/tag-utils.ts";

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

/**
 * Fetch a single page of records from an AT Protocol collection.
 * Returns records and an optional cursor for the next page.
 */
export async function listOnePage(
  oauthSession: any,
  collection: string,
  options?: { cursor?: string; reverse?: boolean; limit?: number },
): Promise<{ records: any[]; cursor?: string }> {
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

  const data = await res.json();
  return {
    records: data.records || [],
    cursor: data.cursor || undefined,
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

/** Re-export for convenience */
export { getClearSessionCookie, getSessionFromRequest };
