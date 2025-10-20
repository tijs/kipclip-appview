import { Hono } from "https://esm.sh/hono";
import type {
  AddBookmarkRequest,
  AddBookmarkResponse,
  EnrichedBookmark,
  ListBookmarksResponse,
  UpdateBookmarkTagsRequest,
  UpdateBookmarkTagsResponse,
} from "../../shared/types.ts";
import { extractUrlMetadata } from "../services/enrichment.ts";
import { getAuthSession, AuthInvalidError, clearSidCookieHeader }
  from "../services/auth.ts";

const BOOKMARK_COLLECTION = "community.lexicon.bookmarks.bookmark";

export const bookmarksApi = new Hono();

/**
 * Get authenticated user session from OAuth
 * Extracts session cookie and gets OAuth session from storage
 */
// use shared getAuthSession from services/auth.ts

/**
 * List user's bookmarks
 */
bookmarksApi.get("/bookmarks", async (c) => {
  try {
    const oauthSession = await getAuthSession(c.req.raw);

    // List records from the bookmark collection using makeRequest
    const params = new URLSearchParams({
      repo: oauthSession.did,
      collection: BOOKMARK_COLLECTION,
      limit: "100",
    });
    const response = await oauthSession.makeRequest(
      "GET",
      `${oauthSession.pdsUrl}/xrpc/com.atproto.repo.listRecords?${params}`,
    );

    if (!response.ok) {
      throw new Error(`Failed to list records: ${await response.text()}`);
    }

    const data = await response.json();

    // Enrich bookmarks with metadata
    const bookmarks: EnrichedBookmark[] = data.records.map(
      (record: any) => ({
        uri: record.uri,
        cid: record.cid,
        subject: record.value.subject,
        createdAt: record.value.createdAt,
        tags: record.value.tags || [],
        title: record.value.$enriched?.title || record.value.title,
        description: record.value.$enriched?.description,
        favicon: record.value.$enriched?.favicon,
      }),
    );

    const result: ListBookmarksResponse = { bookmarks };
    return c.json(result);
  } catch (error: any) {
    console.error("Error listing bookmarks:", error);

    if (error instanceof AuthInvalidError) {
      c.header("Set-Cookie", clearSidCookieHeader());
      return c.json({ error: "Authentication invalid" }, 401);
    }

    // If collection doesn't exist yet, return empty array
    if (error.message?.includes("not found") || error.status === 400) {
      return c.json({ bookmarks: [] });
    }

    return c.json({ error: error.message }, 500);
  }
});

/**
 * Add a new bookmark
 */
bookmarksApi.post("/bookmarks", async (c) => {
  try {
    const oauthSession = await getAuthSession(c.req.raw);
    const body: AddBookmarkRequest = await c.req.json();

    if (!body.url) {
      return c.json({ error: "URL is required" }, 400);
    }

    // Validate URL
    let url: URL;
    try {
      url = new URL(body.url);
      if (!url.protocol.startsWith("http")) {
        return c.json({ error: "Only HTTP(S) URLs are supported" }, 400);
      }
    } catch {
      return c.json({ error: "Invalid URL format" }, 400);
    }

    // Extract metadata
    const metadata = await extractUrlMetadata(body.url);

    // Create bookmark record
    const record = {
      subject: body.url,
      createdAt: new Date().toISOString(),
      tags: [],
      // Store enriched metadata as custom fields
      $enriched: {
        title: metadata.title,
        description: metadata.description,
        favicon: metadata.favicon,
      },
    };

    const response = await oauthSession.makeRequest(
      "POST",
      `${oauthSession.pdsUrl}/xrpc/com.atproto.repo.createRecord`,
      {
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          repo: oauthSession.did,
          collection: BOOKMARK_COLLECTION,
          record,
        }),
      },
    );

    if (!response.ok) {
      throw new Error(`Failed to create record: ${await response.text()}`);
    }

    const data = await response.json();

    const bookmark: EnrichedBookmark = {
      uri: data.uri,
      cid: data.cid,
      subject: body.url,
      createdAt: record.createdAt,
      tags: [],
      title: metadata.title,
      description: metadata.description,
      favicon: metadata.favicon,
    };

    const result: AddBookmarkResponse = {
      success: true,
      bookmark,
    };

    return c.json(result);
  } catch (error: any) {
    console.error("Error creating bookmark:", error);
    if (error instanceof AuthInvalidError) {
      c.header("Set-Cookie", clearSidCookieHeader());
      return c.json({ error: "Authentication invalid" }, 401);
    }
    return c.json({ error: error.message }, 500);
  }
});

/**
 * Update bookmark tags and other fields
 */
bookmarksApi.patch("/bookmarks/:rkey", async (c) => {
  try {
    const oauthSession = await getAuthSession(c.req.raw);
    const rkey = c.req.param("rkey");
    const body: UpdateBookmarkTagsRequest = await c.req.json();

    if (!Array.isArray(body.tags)) {
      return c.json({ error: "Tags must be an array" }, 400);
    }

    // Validate URL if provided
    if (body.url) {
      try {
        const urlObj = new URL(body.url);
        if (!urlObj.protocol.startsWith("http")) {
          return c.json({ error: "Only HTTP(S) URLs are supported" }, 400);
        }
      } catch {
        return c.json({ error: "Invalid URL format" }, 400);
      }
    }

    // Get current record to preserve all fields
    const getParams = new URLSearchParams({
      repo: oauthSession.did,
      collection: BOOKMARK_COLLECTION,
      rkey,
    });
    const getResponse = await oauthSession.makeRequest(
      "GET",
      `${oauthSession.pdsUrl}/xrpc/com.atproto.repo.getRecord?${getParams}`,
    );

    if (!getResponse.ok) {
      throw new Error(`Failed to get record: ${await getResponse.text()}`);
    }

    const currentRecord = await getResponse.json();

    // Update record with new fields
    const record = {
      ...currentRecord.value,
      subject: body.url || currentRecord.value.subject,
      tags: body.tags,
      $enriched: {
        ...currentRecord.value.$enriched,
        title: body.title !== undefined
          ? body.title
          : currentRecord.value.$enriched?.title,
        description: body.description !== undefined
          ? body.description
          : currentRecord.value.$enriched?.description,
      },
    };

    const response = await oauthSession.makeRequest(
      "POST",
      `${oauthSession.pdsUrl}/xrpc/com.atproto.repo.putRecord`,
      {
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          repo: oauthSession.did,
          collection: BOOKMARK_COLLECTION,
          rkey,
          record,
        }),
      },
    );

    if (!response.ok) {
      throw new Error(`Failed to update record: ${await response.text()}`);
    }

    const data = await response.json();

    const bookmark: EnrichedBookmark = {
      uri: data.uri,
      cid: data.cid,
      subject: record.subject,
      createdAt: record.createdAt,
      tags: record.tags,
      title: record.$enriched?.title,
      description: record.$enriched?.description,
      favicon: record.$enriched?.favicon,
    };

    const result: UpdateBookmarkTagsResponse = {
      success: true,
      bookmark,
    };

    return c.json(result);
  } catch (error: any) {
    console.error("Error updating bookmark tags:", error);
    if (error instanceof AuthInvalidError) {
      c.header("Set-Cookie", clearSidCookieHeader());
      return c.json({ error: "Authentication invalid" }, 401);
    }
    return c.json({ error: error.message }, 500);
  }
});

/**
 * Delete a bookmark
 */
bookmarksApi.delete("/bookmarks/:rkey", async (c) => {
  try {
    const oauthSession = await getAuthSession(c.req.raw);
    const rkey = c.req.param("rkey");

    const response = await oauthSession.makeRequest(
      "POST",
      `${oauthSession.pdsUrl}/xrpc/com.atproto.repo.deleteRecord`,
      {
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          repo: oauthSession.did,
          collection: BOOKMARK_COLLECTION,
          rkey,
        }),
      },
    );

    if (!response.ok) {
      throw new Error(`Failed to delete record: ${await response.text()}`);
    }

    return c.json({ success: true });
  } catch (error: any) {
    console.error("Error deleting bookmark:", error);
    if (error instanceof AuthInvalidError) {
      c.header("Set-Cookie", clearSidCookieHeader());
      return c.json({ error: "Authentication invalid" }, 401);
    }
    return c.json({ error: error.message }, 500);
  }
});
