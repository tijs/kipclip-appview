import { Hono } from "https://esm.sh/hono";
import type {
  AddBookmarkRequest,
  AddBookmarkResponse,
  EnrichedBookmark,
  ListBookmarksResponse,
} from "../../shared/types.ts";
import { extractUrlMetadata } from "../services/enrichment.ts";
import { oauth } from "../index.ts";

const BOOKMARK_COLLECTION = "community.lexicon.bookmarks.bookmark";

export const bookmarksApi = new Hono();

/**
 * Get authenticated user session from OAuth
 * Extracts session cookie and gets OAuth session from storage
 */
async function getAuthSession(req: Request) {
  // Extract session cookie
  const cookieHeader = req.headers.get("cookie");
  if (!cookieHeader || !cookieHeader.includes("sid=")) {
    throw new Error("Not authenticated");
  }

  const sessionCookie = cookieHeader
    .split(";")
    .find((c) => c.trim().startsWith("sid="))
    ?.split("=")[1];

  if (!sessionCookie) {
    throw new Error("Not authenticated");
  }

  // Unseal session data to get DID - use the COOKIE_SECRET from env
  const { unsealData } = await import("npm:iron-session@8.0.4");
  const COOKIE_SECRET = Deno.env.get("COOKIE_SECRET");

  if (!COOKIE_SECRET) {
    console.error("COOKIE_SECRET environment variable not set");
    throw new Error("Server configuration error");
  }

  const sessionData = await unsealData(decodeURIComponent(sessionCookie), {
    password: COOKIE_SECRET,
  });

  const userDid = (sessionData as any)?.did || (sessionData as any)?.userId ||
    (sessionData as any)?.sub;

  if (!userDid) {
    console.error("No DID found in session data:", sessionData);
    throw new Error("Not authenticated");
  }

  // Get OAuth session using sessions manager
  const oauthSession = await oauth.sessions.getOAuthSession(userDid);

  if (!oauthSession) {
    console.error("No OAuth session found for DID:", userDid);
    throw new Error("OAuth session not found");
  }

  return oauthSession;
}

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
    return c.json({ error: error.message }, 500);
  }
});
