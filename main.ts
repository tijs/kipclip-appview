/**
 * Main entry point for kipclip Fresh application.
 * Uses programmatic routing for compatibility with existing code structure.
 */

import { App, staticFiles } from "jsr:@fresh/core@^2.2.0";
import { initializeTables } from "./lib/db.ts";
import { oauth } from "./lib/oauth-config.ts";
import { captureError } from "./lib/sentry.ts";
import { getClearSessionCookie, getSessionFromRequest } from "./lib/session.ts";
import { extractUrlMetadata } from "./lib/enrichment.ts";
import { decodeTagsFromUrl } from "./shared/utils.ts";
import { readFile, serveFile } from "./lib/file-server.ts";
import type {
  AddBookmarkRequest,
  AddBookmarkResponse,
  AddTagRequest,
  AddTagResponse,
  DeleteTagResponse,
  EnrichedBookmark,
  EnrichedTag,
  InitialDataResponse,
  ListBookmarksResponse,
  ListTagsResponse,
  SharedBookmarksResponse,
  UpdateBookmarkTagsRequest,
  UpdateBookmarkTagsResponse,
  UpdateTagRequest,
  UpdateTagResponse,
} from "./shared/types.ts";

// Run database migrations on startup
await initializeTables();

// Create the Fresh app
let app = new App();

// Error handling middleware
app = app.use(async (ctx) => {
  try {
    return await ctx.next();
  } catch (err) {
    captureError(err, { url: ctx.req.url, method: ctx.req.method });
    throw err;
  }
});

// Serve static files from /static directory
app.use(staticFiles());

// ============================================================================
// OAuth routes
// ============================================================================

app = app.get("/login", (ctx) => oauth.handleLogin(ctx.req));
app = app.get("/oauth/callback", (ctx) => oauth.handleCallback(ctx.req));

// Serve static OAuth client metadata
app = app.get("/oauth-client-metadata.json", () => {
  return new Response(
    JSON.stringify({
      client_name: "kipclip",
      client_id: "https://kipclip.com/oauth-client-metadata.json",
      client_uri: "https://kipclip.com",
      redirect_uris: ["https://kipclip.com/oauth/callback"],
      scope: "atproto transition:generic",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      application_type: "web",
      token_endpoint_auth_method: "none",
      dpop_bound_access_tokens: true,
      logo_uri: "https://cdn.kipclip.com/images/kip-vignette.png",
    }),
    {
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=3600",
      },
    },
  );
});

app = app.post("/api/auth/logout", (ctx) => oauth.handleLogout(ctx.req));

// ============================================================================
// Auth session endpoints
// ============================================================================

app = app.get("/api/auth/session", async (ctx) => {
  const result = await oauth.getSessionFromRequest(ctx.req);
  if (!result.session) {
    return Response.json(
      { error: result.error?.message || "Not authenticated" },
      { status: 401 },
    );
  }
  const response = Response.json({
    did: result.session.did,
    handle: result.session.handle,
  });
  if (result.setCookieHeader) {
    response.headers.set("Set-Cookie", result.setCookieHeader);
  }
  return response;
});

app = app.get("/api/auth/debug", async (ctx) => {
  const request = ctx.req;
  const cookies = request.headers.get("cookie") || "";
  const hasSidCookie = cookies.includes("sid=");
  const sidCookiePreview = cookies.match(/sid=([^;]+)/)?.[1]?.substring(0, 30);

  const { session, error } = await getSessionFromRequest(request);

  return Response.json({
    debug: {
      timestamp: new Date().toISOString(),
      url: request.url,
      cookies: {
        hasSidCookie,
        sidCookiePreview: sidCookiePreview ? `${sidCookiePreview}...` : null,
      },
      session: session
        ? {
          did: session.did,
          pdsUrl: session.pdsUrl,
        }
        : null,
      error: error || null,
    },
  });
});

// ============================================================================
// Bookmarks routes
// ============================================================================

const BOOKMARK_COLLECTION = "community.lexicon.bookmarks.bookmark";
const TAG_COLLECTION = "com.kipclip.tag";

function setSessionCookie(
  response: Response,
  setCookieHeader: string | undefined,
): Response {
  if (setCookieHeader) {
    response.headers.set("Set-Cookie", setCookieHeader);
  }
  return response;
}

// List bookmarks
app = app.get("/api/bookmarks", async (ctx) => {
  try {
    const { session: oauthSession, setCookieHeader, error } =
      await getSessionFromRequest(ctx.req);
    if (!oauthSession) {
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
      const errorText = await response.text();
      throw new Error(`Failed to list records: ${errorText}`);
    }

    const data = await response.json();
    const bookmarks: EnrichedBookmark[] = data.records.map((record: any) => ({
      uri: record.uri,
      cid: record.cid,
      subject: record.value.subject,
      createdAt: record.value.createdAt,
      tags: record.value.tags || [],
      title: record.value.$enriched?.title || record.value.title,
      description: record.value.$enriched?.description,
      favicon: record.value.$enriched?.favicon,
    }));

    const result: ListBookmarksResponse = { bookmarks };
    return setSessionCookie(Response.json(result), setCookieHeader);
  } catch (error: any) {
    console.error("Error listing bookmarks:", error);
    if (error.message?.includes("not found") || error.status === 400) {
      return Response.json({ bookmarks: [] });
    }
    return Response.json({ error: error.message }, { status: 500 });
  }
});

// Add bookmark
app = app.post("/api/bookmarks", async (ctx) => {
  try {
    const { session: oauthSession, setCookieHeader, error } =
      await getSessionFromRequest(ctx.req);
    if (!oauthSession) {
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

    const body: AddBookmarkRequest = await ctx.req.json();
    if (!body.url) {
      return Response.json({ error: "URL is required" }, { status: 400 });
    }

    let url: URL;
    try {
      url = new URL(body.url);
      if (!url.protocol.startsWith("http")) {
        return Response.json(
          { error: "Only HTTP(S) URLs are supported" },
          { status: 400 },
        );
      }
    } catch {
      return Response.json({ error: "Invalid URL format" }, { status: 400 });
    }

    const metadata = await extractUrlMetadata(body.url);

    const record = {
      subject: body.url,
      createdAt: new Date().toISOString(),
      tags: [],
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
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          repo: oauthSession.did,
          collection: BOOKMARK_COLLECTION,
          record,
        }),
      },
    );

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to create record: ${errorText}`);
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

    const result: AddBookmarkResponse = { success: true, bookmark };
    return setSessionCookie(Response.json(result), setCookieHeader);
  } catch (error: any) {
    console.error("Error creating bookmark:", error);
    return Response.json({ error: error.message }, { status: 500 });
  }
});

// Update bookmark
app = app.patch("/api/bookmarks/:rkey", async (ctx) => {
  try {
    const { session: oauthSession, setCookieHeader, error } =
      await getSessionFromRequest(ctx.req);
    if (!oauthSession) {
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

    const rkey = ctx.params.rkey;
    const body: UpdateBookmarkTagsRequest = await ctx.req.json();

    if (!Array.isArray(body.tags)) {
      return Response.json({ error: "Tags must be an array" }, { status: 400 });
    }

    if (body.url) {
      try {
        const urlObj = new URL(body.url);
        if (!urlObj.protocol.startsWith("http")) {
          return Response.json(
            { error: "Only HTTP(S) URLs are supported" },
            { status: 400 },
          );
        }
      } catch {
        return Response.json({ error: "Invalid URL format" }, { status: 400 });
      }
    }

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
      const errorText = await getResponse.text();
      throw new Error(`Failed to get record: ${errorText}`);
    }

    const currentRecord = await getResponse.json();
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
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          repo: oauthSession.did,
          collection: BOOKMARK_COLLECTION,
          rkey,
          record,
        }),
      },
    );

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to update record: ${errorText}`);
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

    const result: UpdateBookmarkTagsResponse = { success: true, bookmark };
    return setSessionCookie(Response.json(result), setCookieHeader);
  } catch (error: any) {
    console.error("Error updating bookmark tags:", error);
    return Response.json({ error: error.message }, { status: 500 });
  }
});

// Delete bookmark
app = app.delete("/api/bookmarks/:rkey", async (ctx) => {
  try {
    const { session: oauthSession, setCookieHeader, error } =
      await getSessionFromRequest(ctx.req);
    if (!oauthSession) {
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

    const rkey = ctx.params.rkey;
    const response = await oauthSession.makeRequest(
      "POST",
      `${oauthSession.pdsUrl}/xrpc/com.atproto.repo.deleteRecord`,
      {
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          repo: oauthSession.did,
          collection: BOOKMARK_COLLECTION,
          rkey,
        }),
      },
    );

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to delete record: ${errorText}`);
    }

    return setSessionCookie(Response.json({ success: true }), setCookieHeader);
  } catch (error: any) {
    console.error("Error deleting bookmark:", error);
    return Response.json({ error: error.message }, { status: 500 });
  }
});

// ============================================================================
// Tags routes
// ============================================================================

// List tags
app = app.get("/api/tags", async (ctx) => {
  try {
    const { session: oauthSession, setCookieHeader, error } =
      await getSessionFromRequest(ctx.req);
    if (!oauthSession) {
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

    const params = new URLSearchParams({
      repo: oauthSession.did,
      collection: TAG_COLLECTION,
      limit: "100",
    });
    const response = await oauthSession.makeRequest(
      "GET",
      `${oauthSession.pdsUrl}/xrpc/com.atproto.repo.listRecords?${params}`,
    );

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to list records: ${errorText}`);
    }

    const data = await response.json();
    const tags: EnrichedTag[] = data.records.map((record: any) => ({
      uri: record.uri,
      cid: record.cid,
      value: record.value.value,
      createdAt: record.value.createdAt,
    }));

    const result: ListTagsResponse = { tags };
    return setSessionCookie(Response.json(result), setCookieHeader);
  } catch (error: any) {
    console.error("Error listing tags:", error);
    if (error.message?.includes("not found") || error.status === 400) {
      return Response.json({ tags: [] });
    }
    return Response.json({ error: error.message }, { status: 500 });
  }
});

// Add tag
app = app.post("/api/tags", async (ctx) => {
  try {
    const { session: oauthSession, setCookieHeader, error } =
      await getSessionFromRequest(ctx.req);
    if (!oauthSession) {
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

    const body: AddTagRequest = await ctx.req.json();
    if (!body.value || typeof body.value !== "string") {
      return Response.json({ error: "Tag value is required" }, { status: 400 });
    }

    const value = body.value.trim();
    if (value.length === 0) {
      return Response.json({ error: "Tag value cannot be empty" }, {
        status: 400,
      });
    }
    if (value.length > 64) {
      return Response.json(
        { error: "Tag value must be 64 characters or less" },
        { status: 400 },
      );
    }

    const record = {
      value: value,
      createdAt: new Date().toISOString(),
    };

    const response = await oauthSession.makeRequest(
      "POST",
      `${oauthSession.pdsUrl}/xrpc/com.atproto.repo.createRecord`,
      {
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          repo: oauthSession.did,
          collection: TAG_COLLECTION,
          record,
        }),
      },
    );

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to create record: ${errorText}`);
    }

    const data = await response.json();
    const tag: EnrichedTag = {
      uri: data.uri,
      cid: data.cid,
      value: value,
      createdAt: record.createdAt,
    };

    const result: AddTagResponse = { success: true, tag };
    return setSessionCookie(Response.json(result), setCookieHeader);
  } catch (error: any) {
    console.error("Error creating tag:", error);
    return Response.json({ error: error.message }, { status: 500 });
  }
});

// Update tag
app = app.put("/api/tags/:rkey", async (ctx) => {
  try {
    const { session: oauthSession, setCookieHeader, error } =
      await getSessionFromRequest(ctx.req);
    if (!oauthSession) {
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

    const rkey = ctx.params.rkey;
    const body: UpdateTagRequest = await ctx.req.json();

    if (!body.value || typeof body.value !== "string") {
      return Response.json({ error: "Tag value is required" }, { status: 400 });
    }

    const newValue = body.value.trim();
    if (newValue.length === 0) {
      return Response.json({ error: "Tag value cannot be empty" }, {
        status: 400,
      });
    }
    if (newValue.length > 64) {
      return Response.json(
        { error: "Tag value must be 64 characters or less" },
        { status: 400 },
      );
    }

    // Get current record
    const getParams = new URLSearchParams({
      repo: oauthSession.did,
      collection: TAG_COLLECTION,
      rkey,
    });
    const getResponse = await oauthSession.makeRequest(
      "GET",
      `${oauthSession.pdsUrl}/xrpc/com.atproto.repo.getRecord?${getParams}`,
    );

    if (!getResponse.ok) {
      const errorText = await getResponse.text();
      throw new Error(`Failed to get record: ${errorText}`);
    }

    const currentRecord = await getResponse.json();
    const oldValue = currentRecord.value.value;

    // If value hasn't changed, return success
    if (oldValue === newValue) {
      const tag: EnrichedTag = {
        uri: currentRecord.uri,
        cid: currentRecord.cid,
        value: newValue,
        createdAt: currentRecord.value.createdAt,
      };
      return setSessionCookie(
        Response.json({ success: true, tag }),
        setCookieHeader,
      );
    }

    // Update bookmarks with the old tag value
    const listParams = new URLSearchParams({
      repo: oauthSession.did,
      collection: BOOKMARK_COLLECTION,
      limit: "100",
    });
    const listResponse = await oauthSession.makeRequest(
      "GET",
      `${oauthSession.pdsUrl}/xrpc/com.atproto.repo.listRecords?${listParams}`,
    );

    if (listResponse.ok) {
      const bookmarksData = await listResponse.json();
      const updatePromises = bookmarksData.records
        .filter((record: any) => record.value.tags?.includes(oldValue))
        .map(async (record: any) => {
          const bookmarkRkey = record.uri.split("/").pop();
          const updatedTags = record.value.tags.map((t: string) =>
            t === oldValue ? newValue : t
          );

          const updateResponse = await oauthSession.makeRequest(
            "POST",
            `${oauthSession.pdsUrl}/xrpc/com.atproto.repo.putRecord`,
            {
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                repo: oauthSession.did,
                collection: BOOKMARK_COLLECTION,
                rkey: bookmarkRkey,
                record: { ...record.value, tags: updatedTags },
              }),
            },
          );

          if (!updateResponse.ok) {
            console.error(
              `Failed to update bookmark ${bookmarkRkey}:`,
              await updateResponse.text(),
            );
          }
          return updateResponse.ok;
        });

      await Promise.all(updatePromises);
    }

    // Update the tag record
    const record = {
      value: newValue,
      createdAt: currentRecord.value.createdAt,
    };

    const updateResponse = await oauthSession.makeRequest(
      "POST",
      `${oauthSession.pdsUrl}/xrpc/com.atproto.repo.putRecord`,
      {
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          repo: oauthSession.did,
          collection: TAG_COLLECTION,
          rkey,
          record,
        }),
      },
    );

    if (!updateResponse.ok) {
      const errorText = await updateResponse.text();
      throw new Error(`Failed to update tag record: ${errorText}`);
    }

    const data = await updateResponse.json();
    const tag: EnrichedTag = {
      uri: data.uri,
      cid: data.cid,
      value: newValue,
      createdAt: record.createdAt,
    };

    const result: UpdateTagResponse = { success: true, tag };
    return setSessionCookie(Response.json(result), setCookieHeader);
  } catch (error: any) {
    console.error("Error updating tag:", error);
    return Response.json({ error: error.message }, { status: 500 });
  }
});

// Get tag usage
app = app.get("/api/tags/:rkey/usage", async (ctx) => {
  try {
    const { session: oauthSession, setCookieHeader, error } =
      await getSessionFromRequest(ctx.req);
    if (!oauthSession) {
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

    const rkey = ctx.params.rkey;

    // Get the tag
    const getParams = new URLSearchParams({
      repo: oauthSession.did,
      collection: TAG_COLLECTION,
      rkey,
    });
    const getResponse = await oauthSession.makeRequest(
      "GET",
      `${oauthSession.pdsUrl}/xrpc/com.atproto.repo.getRecord?${getParams}`,
    );

    if (!getResponse.ok) {
      const errorText = await getResponse.text();
      throw new Error(`Failed to get tag: ${errorText}`);
    }

    const tagData = await getResponse.json();
    const tagValue = tagData.value.value;

    // List all bookmarks
    const listParams = new URLSearchParams({
      repo: oauthSession.did,
      collection: BOOKMARK_COLLECTION,
      limit: "100",
    });
    const listResponse = await oauthSession.makeRequest(
      "GET",
      `${oauthSession.pdsUrl}/xrpc/com.atproto.repo.listRecords?${listParams}`,
    );

    if (!listResponse.ok) {
      const errorText = await listResponse.text();
      throw new Error(`Failed to list bookmarks: ${errorText}`);
    }

    const bookmarksData = await listResponse.json();
    const count = bookmarksData.records.filter((record: any) =>
      record.value.tags?.includes(tagValue)
    ).length;

    return setSessionCookie(
      Response.json({ count, tagValue }),
      setCookieHeader,
    );
  } catch (error: any) {
    console.error("Error getting tag usage:", error);
    return Response.json({ error: error.message }, { status: 500 });
  }
});

// Delete tag
app = app.delete("/api/tags/:rkey", async (ctx) => {
  try {
    const { session: oauthSession, setCookieHeader, error } =
      await getSessionFromRequest(ctx.req);
    if (!oauthSession) {
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

    const rkey = ctx.params.rkey;

    // Get the tag
    const getParams = new URLSearchParams({
      repo: oauthSession.did,
      collection: TAG_COLLECTION,
      rkey,
    });
    const getResponse = await oauthSession.makeRequest(
      "GET",
      `${oauthSession.pdsUrl}/xrpc/com.atproto.repo.getRecord?${getParams}`,
    );

    if (!getResponse.ok) {
      const errorText = await getResponse.text();
      throw new Error(`Failed to get tag: ${errorText}`);
    }

    const tagData = await getResponse.json();
    const tagValue = tagData.value.value;

    // Remove tag from all bookmarks
    const listParams = new URLSearchParams({
      repo: oauthSession.did,
      collection: BOOKMARK_COLLECTION,
      limit: "100",
    });
    const listResponse = await oauthSession.makeRequest(
      "GET",
      `${oauthSession.pdsUrl}/xrpc/com.atproto.repo.listRecords?${listParams}`,
    );

    if (listResponse.ok) {
      const bookmarksData = await listResponse.json();
      const updatePromises = bookmarksData.records
        .filter((record: any) => record.value.tags?.includes(tagValue))
        .map(async (record: any) => {
          const bookmarkRkey = record.uri.split("/").pop();
          const updatedTags = record.value.tags.filter((t: string) =>
            t !== tagValue
          );

          const updateResponse = await oauthSession.makeRequest(
            "POST",
            `${oauthSession.pdsUrl}/xrpc/com.atproto.repo.putRecord`,
            {
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                repo: oauthSession.did,
                collection: BOOKMARK_COLLECTION,
                rkey: bookmarkRkey,
                record: { ...record.value, tags: updatedTags },
              }),
            },
          );

          if (!updateResponse.ok) {
            console.error(
              `Failed to update bookmark ${bookmarkRkey}:`,
              await updateResponse.text(),
            );
          }
          return updateResponse.ok;
        });

      await Promise.all(updatePromises);
    }

    // Delete the tag record
    const deleteResponse = await oauthSession.makeRequest(
      "POST",
      `${oauthSession.pdsUrl}/xrpc/com.atproto.repo.deleteRecord`,
      {
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          repo: oauthSession.did,
          collection: TAG_COLLECTION,
          rkey,
        }),
      },
    );

    if (!deleteResponse.ok) {
      const errorText = await deleteResponse.text();
      throw new Error(`Failed to delete tag record: ${errorText}`);
    }

    const result: DeleteTagResponse = { success: true };
    return setSessionCookie(Response.json(result), setCookieHeader);
  } catch (error: any) {
    console.error("Error deleting tag:", error);
    const result: DeleteTagResponse = { success: false, error: error.message };
    return Response.json(result, { status: 500 });
  }
});

// ============================================================================
// Initial data (combined bookmarks + tags)
// ============================================================================

app = app.get("/api/initial-data", async (ctx) => {
  try {
    const { session: oauthSession, setCookieHeader, error } =
      await getSessionFromRequest(ctx.req);

    if (!oauthSession) {
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

    const bookmarksParams = new URLSearchParams({
      repo: oauthSession.did,
      collection: BOOKMARK_COLLECTION,
      limit: "100",
    });

    const tagsParams = new URLSearchParams({
      repo: oauthSession.did,
      collection: TAG_COLLECTION,
      limit: "100",
    });

    const [bookmarksResponse, tagsResponse] = await Promise.all([
      oauthSession.makeRequest(
        "GET",
        `${oauthSession.pdsUrl}/xrpc/com.atproto.repo.listRecords?${bookmarksParams}`,
      ),
      oauthSession.makeRequest(
        "GET",
        `${oauthSession.pdsUrl}/xrpc/com.atproto.repo.listRecords?${tagsParams}`,
      ),
    ]);

    let bookmarks: EnrichedBookmark[] = [];
    if (bookmarksResponse.ok) {
      const bookmarksData = await bookmarksResponse.json();
      bookmarks = bookmarksData.records.map((record: any) => ({
        uri: record.uri,
        cid: record.cid,
        subject: record.value.subject,
        createdAt: record.value.createdAt,
        tags: record.value.tags || [],
        title: record.value.$enriched?.title || record.value.title,
        description: record.value.$enriched?.description,
        favicon: record.value.$enriched?.favicon,
      }));
    }

    let tags: EnrichedTag[] = [];
    if (tagsResponse.ok) {
      const tagsData = await tagsResponse.json();
      tags = tagsData.records.map((record: any) => ({
        uri: record.uri,
        cid: record.cid,
        value: record.value.value,
        createdAt: record.value.createdAt,
      }));
    }

    const result: InitialDataResponse = { bookmarks, tags };
    return setSessionCookie(Response.json(result), setCookieHeader);
  } catch (error: any) {
    console.error("Error fetching initial data:", error);
    return Response.json({ error: error.message }, { status: 500 });
  }
});

// ============================================================================
// Shared bookmarks (public)
// ============================================================================

app = app.get("/api/share/:did/:encodedTags", async (ctx) => {
  try {
    const did = ctx.params.did;
    const encodedTags = ctx.params.encodedTags;

    let tags: string[];
    try {
      tags = decodeTagsFromUrl(encodedTags);
    } catch (err: any) {
      return Response.json(
        { error: `Invalid tag encoding: ${err.message}` },
        { status: 400 },
      );
    }

    if (!did.startsWith("did:")) {
      return Response.json({ error: "Invalid DID format" }, { status: 400 });
    }

    const didDocResponse = await fetch(`https://plc.directory/${did}`);
    if (!didDocResponse.ok) {
      return Response.json({ error: "User not found" }, { status: 404 });
    }

    const didDoc = await didDocResponse.json();
    const pdsService = didDoc.service?.find((s: any) =>
      s.id === "#atproto_pds"
    );
    if (!pdsService?.serviceEndpoint) {
      return Response.json({ error: "User's PDS not found" }, { status: 404 });
    }

    const pdsUrl = pdsService.serviceEndpoint;
    let handle = did;
    if (didDoc.alsoKnownAs && didDoc.alsoKnownAs.length > 0) {
      const atUri = didDoc.alsoKnownAs.find((aka: string) =>
        aka.startsWith("at://")
      );
      if (atUri) {
        handle = atUri.replace("at://", "");
      }
    }

    const params = new URLSearchParams({
      repo: did,
      collection: BOOKMARK_COLLECTION,
      limit: "100",
    });

    const response = await fetch(
      `${pdsUrl}/xrpc/com.atproto.repo.listRecords?${params}`,
    );

    if (!response.ok) {
      const errorText = await response.text();
      if (response.status === 400 || errorText.includes("not found")) {
        const result: SharedBookmarksResponse = { bookmarks: [], handle, tags };
        return Response.json(result);
      }
      throw new Error(`Failed to fetch bookmarks: ${errorText}`);
    }

    const data = await response.json();
    const allBookmarks: EnrichedBookmark[] = data.records.map((
      record: any,
    ) => ({
      uri: record.uri,
      cid: record.cid,
      subject: record.value.subject,
      createdAt: record.value.createdAt,
      tags: record.value.tags || [],
      title: record.value.$enriched?.title || record.value.title,
      description: record.value.$enriched?.description,
      favicon: record.value.$enriched?.favicon,
    }));

    const filteredBookmarks = allBookmarks.filter((bookmark) =>
      tags.every((tag) => bookmark.tags?.includes(tag))
    );

    const result: SharedBookmarksResponse = {
      bookmarks: filteredBookmarks,
      handle,
      tags,
    };

    return Response.json(result);
  } catch (error: any) {
    console.error("Error fetching shared bookmarks:", error);
    return Response.json({ error: error.message }, { status: 500 });
  }
});

// ============================================================================
// RSS feed
// ============================================================================

function escapeXml(unsafe: string): string {
  return unsafe
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function toRFC822Date(isoDate: string): string {
  return new Date(isoDate).toUTCString();
}

app = app.get("/share/:did/:encodedTags/rss", async (ctx) => {
  try {
    const did = ctx.params.did;
    const encodedTags = ctx.params.encodedTags;

    const tags = decodeTagsFromUrl(encodedTags);
    if (!tags || tags.length === 0) {
      return new Response("Invalid tags", { status: 400 });
    }

    const didDoc = await fetch(`https://plc.directory/${did}`).then((r) =>
      r.json()
    );
    const pdsEndpoint = didDoc.service?.find(
      (s: any) => s.type === "AtprotoPersonalDataServer",
    )?.serviceEndpoint;

    if (!pdsEndpoint) {
      return new Response("PDS not found", { status: 404 });
    }

    const handle = didDoc.alsoKnownAs?.[0]?.replace("at://", "") || did;

    const bookmarksResponse = await fetch(
      `${pdsEndpoint}/xrpc/com.atproto.repo.listRecords?` +
        new URLSearchParams({
          repo: did,
          collection: BOOKMARK_COLLECTION,
          limit: "100",
        }),
    );

    if (!bookmarksResponse.ok) {
      return new Response("Failed to fetch bookmarks", { status: 500 });
    }

    const bookmarksData = await bookmarksResponse.json();
    const filteredBookmarks = bookmarksData.records
      .filter((record: any) => {
        const recordTags = record.value?.tags || [];
        return tags.every((tag) => recordTags.includes(tag));
      })
      .map((record: any) => ({
        uri: record.uri,
        cid: record.cid,
        subject: record.value.subject,
        createdAt: record.value.createdAt,
        tags: record.value.tags || [],
        title: record.value.$enriched?.title,
        description: record.value.$enriched?.description,
        favicon: record.value.$enriched?.favicon,
      }))
      .sort(
        (a: any, b: any) =>
          new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
      );

    const tagsDisplay = tags.join(", ");
    const channelTitle = `${handle}'s ${tagsDisplay} bookmarks`;
    const channelDescription =
      `Bookmarks tagged with ${tagsDisplay} by ${handle}`;
    const channelLink = `https://kipclip.com/share/${did}/${encodedTags}`;
    const feedUrl = `https://kipclip.com/share/${did}/${encodedTags}/rss`;

    const items = filteredBookmarks
      .map((bookmark: any) => {
        const title = escapeXml(bookmark.title || bookmark.subject);
        const description = escapeXml(
          bookmark.description || "No description available",
        );
        const link = escapeXml(bookmark.subject);
        const pubDate = toRFC822Date(bookmark.createdAt);
        const guid = escapeXml(bookmark.uri);

        return `    <item>
      <title>${title}</title>
      <link>${link}</link>
      <description>${description}</description>
      <pubDate>${pubDate}</pubDate>
      <guid isPermaLink="false">${guid}</guid>
    </item>`;
      })
      .join("\n");

    const rssXml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${escapeXml(channelTitle)}</title>
    <link>${escapeXml(channelLink)}</link>
    <description>${escapeXml(channelDescription)}</description>
    <language>en</language>
    <atom:link href="${
      escapeXml(feedUrl)
    }" rel="self" type="application/rss+xml" />
${items}
  </channel>
</rss>`;

    return new Response(rssXml, {
      headers: { "Content-Type": "application/rss+xml; charset=utf-8" },
    });
  } catch (error) {
    console.error("RSS generation error:", error);
    throw error;
  }
});

// ============================================================================
// Static files and SPA routing
// ============================================================================

app = app.get("/robots.txt", () => {
  return new Response(
    `User-agent: *
Allow: /
Disallow: /api/
Disallow: /oauth/

Sitemap: https://kipclip.com/sitemap.xml
`,
    {
      headers: {
        "Content-Type": "text/plain",
        "Cache-Control": "public, max-age=86400",
      },
    },
  );
});

// Serve frontend files
app = app.get("/frontend/*", (ctx) => {
  const path = new URL(ctx.req.url).pathname;
  return serveFile(path, import.meta.url);
});

app = app.get("/shared/*", (ctx) => {
  const path = new URL(ctx.req.url).pathname;
  return serveFile(path, import.meta.url);
});

app = app.get("/lexicons/*", (ctx) => {
  const path = new URL(ctx.req.url).pathname;
  return serveFile(path, import.meta.url);
});

app = app.get("/.well-known/atproto/lexicons/*", (ctx) => {
  const path = new URL(ctx.req.url).pathname.replace(
    "/.well-known/atproto/lexicons",
    "/lexicons",
  );
  return serveFile(path, import.meta.url);
});

// Serve index.html for root
app = app.get("/", async () => {
  const html = await readFile("/frontend/index.html", import.meta.url);
  return new Response(html, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
});

// Catch-all for SPA routing (must be last)
app = app.get("*", async (ctx) => {
  const path = new URL(ctx.req.url).pathname;

  // Don't catch API routes or static assets
  if (
    path.startsWith("/api") ||
    path.startsWith("/oauth") ||
    path.startsWith("/login")
  ) {
    return new Response("Not Found", { status: 404 });
  }

  // Handle share URLs with server-side meta tag injection
  if (path.startsWith("/share/")) {
    try {
      const pathParts = path.split("/").filter((p) => p);
      if (pathParts.length === 3 && pathParts[0] === "share") {
        const did = pathParts[1];
        const encodedTags = pathParts[2];
        const tags = decodeTagsFromUrl(encodedTags);

        const baseUrl = ctx.req.url.split("/share/")[0];
        const apiUrl = `${baseUrl}/api/share/${did}/${encodedTags}`;
        const response = await fetch(apiUrl);

        if (response.ok) {
          const data = await response.json();
          const { handle, bookmarks } = data;

          let html = await readFile("/frontend/index.html", import.meta.url);

          const title = `${handle}'s Bookmarks Collection: ${tags.join(", ")}`;
          const description = bookmarks.length > 0
            ? `${bookmarks.length} bookmark${
              bookmarks.length === 1 ? "" : "s"
            } tagged with ${tags.join(", ")}`
            : `Bookmark collection tagged with ${tags.join(", ")}`;
          const url = ctx.req.url;

          const escapeHtml = (str: string) =>
            str.replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(
              />/g,
              "&gt;",
            );
          const titleEscaped = escapeHtml(title);
          const descriptionEscaped = escapeHtml(description);
          const urlEscaped = escapeHtml(url);

          html = html.replace(
            /<title>[\s\S]*?<\/title>/,
            `<title>${titleEscaped}</title>`,
          );
          html = html.replace(
            /property="og:title"\s+content="[^"]*"/,
            `property="og:title" content="${titleEscaped}"`,
          );
          html = html.replace(
            /name="twitter:title"\s+content="[^"]*"/,
            `name="twitter:title" content="${titleEscaped}"`,
          );
          html = html.replace(
            /name="description"\s+content="[^"]*"/,
            `name="description" content="${descriptionEscaped}"`,
          );
          html = html.replace(
            /property="og:description"\s+content="[^"]*"/,
            `property="og:description" content="${descriptionEscaped}"`,
          );
          html = html.replace(
            /name="twitter:description"\s+content="[^"]*"/,
            `name="twitter:description" content="${descriptionEscaped}"`,
          );
          html = html.replace(
            /property="og:url"\s+content="[^"]*"/,
            `property="og:url" content="${urlEscaped}"`,
          );
          html = html.replace(
            /name="twitter:url"\s+content="[^"]*"/,
            `name="twitter:url" content="${urlEscaped}"`,
          );

          const rssUrl = `${baseUrl}/share/${did}/${encodedTags}/rss`;
          const rssUrlEscaped = escapeHtml(rssUrl);
          const rssLink =
            `\n    <link rel="alternate" type="application/rss+xml" title="${titleEscaped}" href="${rssUrlEscaped}" />`;
          html = html.replace(/<\/head>/, `${rssLink}\n  </head>`);

          return new Response(html, {
            headers: { "Content-Type": "text/html; charset=utf-8" },
          });
        }
      }
    } catch (error) {
      console.error("Error generating share page meta tags:", error);
    }
  }

  // Default: serve base HTML for all other routes
  const html = await readFile("/frontend/index.html", import.meta.url);
  return new Response(html, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
});

// Export app for Fresh build system
export { app };
