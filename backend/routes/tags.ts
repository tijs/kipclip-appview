import type { App } from "jsr:@fresh/core@^2.2.0";

// Fresh App with any state type (we don't use Fresh's state management)
type FreshApp = App<any>;
import type {
  AddTagRequest,
  AddTagResponse,
  DeleteTagResponse,
  EnrichedTag,
  ListTagsResponse,
  UpdateTagRequest,
  UpdateTagResponse,
} from "../../shared/types.ts";
import {
  getClearSessionCookie,
  getSessionFromRequest,
} from "../utils/session.ts";

const TAG_COLLECTION = "com.kipclip.tag";

/**
 * Helper to set session refresh cookie on response
 */
function setSessionCookie(
  response: Response,
  setCookieHeader: string | undefined,
): Response {
  if (setCookieHeader) {
    response.headers.set("Set-Cookie", setCookieHeader);
  }
  return response;
}

/**
 * Register tag routes on the Fresh app
 */
export function registerTagsRoutes(app: FreshApp): FreshApp {
  /**
   * List user's tags
   */
  app = app.get("/api/tags", async (ctx) => {
    try {
      // Get authenticated session with detailed error logging
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

      // List records from the tag collection using makeRequest
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

      // Map to enriched tags
      const tags: EnrichedTag[] = data.records.map(
        (record: any) => ({
          uri: record.uri,
          cid: record.cid,
          value: record.value.value,
          createdAt: record.value.createdAt,
        }),
      );

      const result: ListTagsResponse = { tags };
      return setSessionCookie(Response.json(result), setCookieHeader);
    } catch (error: any) {
      console.error("Error listing tags:", error);

      // If collection doesn't exist yet, return empty array
      if (error.message?.includes("not found") || error.status === 400) {
        return Response.json({ tags: [] });
      }

      return Response.json({ error: error.message }, { status: 500 });
    }
  });

  /**
   * Add a new tag
   */
  app = app.post("/api/tags", async (ctx) => {
    try {
      // Get authenticated session with detailed error logging
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
        return Response.json({ error: "Tag value is required" }, {
          status: 400,
        });
      }

      // Validate tag value
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

      // Create tag record
      const record = {
        value: value,
        createdAt: new Date().toISOString(),
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

      const result: AddTagResponse = {
        success: true,
        tag,
      };

      return setSessionCookie(Response.json(result), setCookieHeader);
    } catch (error: any) {
      console.error("Error creating tag:", error);

      return Response.json({ error: error.message }, { status: 500 });
    }
  });

  /**
   * Update a tag and rename it in all bookmarks
   */
  app = app.put("/api/tags/:rkey", async (ctx) => {
    try {
      // Get authenticated session with detailed error logging
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
        return Response.json({ error: "Tag value is required" }, {
          status: 400,
        });
      }

      // Validate tag value
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

      // Get current record to get old value and preserve createdAt
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
        if (getResponse.status === 401 || getResponse.status === 403) {
          throw Object.assign(
            new Error(`Authentication failed: ${errorText}`),
            { status: getResponse.status },
          );
        }
        throw new Error(`Failed to get record: ${errorText}`);
      }

      const currentRecord = await getResponse.json();
      const oldValue = currentRecord.value.value;

      // If value hasn't changed, just return success
      if (oldValue === newValue) {
        const tag: EnrichedTag = {
          uri: currentRecord.uri,
          cid: currentRecord.cid,
          value: newValue,
          createdAt: currentRecord.value.createdAt,
        };

        return setSessionCookie(
          Response.json({
            success: true,
            tag,
          }),
          setCookieHeader,
        );
      }

      // Update all bookmarks that have the old tag value
      const BOOKMARK_COLLECTION = "community.lexicon.bookmarks.bookmark";
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

        // Update each bookmark that has the old tag
        const updatePromises = bookmarksData.records
          .filter((record: any) => record.value.tags?.includes(oldValue))
          .map(async (record: any) => {
            const bookmarkRkey = record.uri.split("/").pop();
            const updatedTags = record.value.tags.map((t: string) =>
              t === oldValue ? newValue : t
            );

            // Update the bookmark record with renamed tag
            const updateResponse = await oauthSession.makeRequest(
              "POST",
              `${oauthSession.pdsUrl}/xrpc/com.atproto.repo.putRecord`,
              {
                headers: {
                  "Content-Type": "application/json",
                },
                body: JSON.stringify({
                  repo: oauthSession.did,
                  collection: BOOKMARK_COLLECTION,
                  rkey: bookmarkRkey,
                  record: {
                    ...record.value,
                    tags: updatedTags,
                  },
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

        // Wait for all bookmark updates to complete
        await Promise.all(updatePromises);
      }

      // Now update the tag record
      const record = {
        value: newValue,
        createdAt: currentRecord.value.createdAt, // Preserve original createdAt
      };

      const updateResponse = await oauthSession.makeRequest(
        "POST",
        `${oauthSession.pdsUrl}/xrpc/com.atproto.repo.putRecord`,
        {
          headers: {
            "Content-Type": "application/json",
          },
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
        if (updateResponse.status === 401 || updateResponse.status === 403) {
          throw Object.assign(
            new Error(`Authentication failed: ${errorText}`),
            { status: updateResponse.status },
          );
        }
        throw new Error(`Failed to update tag record: ${errorText}`);
      }

      const data = await updateResponse.json();

      const tag: EnrichedTag = {
        uri: data.uri,
        cid: data.cid,
        value: newValue,
        createdAt: record.createdAt,
      };

      const result: UpdateTagResponse = {
        success: true,
        tag,
      };

      return setSessionCookie(Response.json(result), setCookieHeader);
    } catch (error: any) {
      console.error("Error updating tag:", error);

      return Response.json({ error: error.message }, { status: 500 });
    }
  });

  /**
   * Get tag usage (count of bookmarks using this tag)
   */
  app = app.get("/api/tags/:rkey/usage", async (ctx) => {
    try {
      // Get authenticated session with detailed error logging
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

      // First, get the tag to find its value
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
        if (getResponse.status === 401 || getResponse.status === 403) {
          throw Object.assign(
            new Error(`Authentication failed: ${errorText}`),
            { status: getResponse.status },
          );
        }
        throw new Error(`Failed to get tag: ${errorText}`);
      }

      const tagData = await getResponse.json();
      const tagValue = tagData.value.value;

      // List all bookmarks
      const BOOKMARK_COLLECTION = "community.lexicon.bookmarks.bookmark";
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
        if (listResponse.status === 401 || listResponse.status === 403) {
          throw Object.assign(
            new Error(`Authentication failed: ${errorText}`),
            { status: listResponse.status },
          );
        }
        throw new Error(`Failed to list bookmarks: ${errorText}`);
      }

      const bookmarksData = await listResponse.json();

      // Count bookmarks that have this tag
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

  /**
   * Delete a tag and remove it from all bookmarks
   */
  app = app.delete("/api/tags/:rkey", async (ctx) => {
    try {
      // Get authenticated session with detailed error logging
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

      // First, get the tag to find its value
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
        if (getResponse.status === 401 || getResponse.status === 403) {
          throw Object.assign(
            new Error(`Authentication failed: ${errorText}`),
            { status: getResponse.status },
          );
        }
        throw new Error(`Failed to get tag: ${errorText}`);
      }

      const tagData = await getResponse.json();
      const tagValue = tagData.value.value;

      // List all bookmarks to find which ones have this tag
      const BOOKMARK_COLLECTION = "community.lexicon.bookmarks.bookmark";
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

        // Update each bookmark that has this tag
        const updatePromises = bookmarksData.records
          .filter((record: any) => record.value.tags?.includes(tagValue))
          .map(async (record: any) => {
            const bookmarkRkey = record.uri.split("/").pop();
            const updatedTags = record.value.tags.filter(
              (t: string) => t !== tagValue,
            );

            // Update the bookmark record with tags removed
            const updateResponse = await oauthSession.makeRequest(
              "POST",
              `${oauthSession.pdsUrl}/xrpc/com.atproto.repo.putRecord`,
              {
                headers: {
                  "Content-Type": "application/json",
                },
                body: JSON.stringify({
                  repo: oauthSession.did,
                  collection: BOOKMARK_COLLECTION,
                  rkey: bookmarkRkey,
                  record: {
                    ...record.value,
                    tags: updatedTags,
                  },
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

        // Wait for all bookmark updates to complete
        await Promise.all(updatePromises);
      }

      // Now delete the tag record
      const deleteResponse = await oauthSession.makeRequest(
        "POST",
        `${oauthSession.pdsUrl}/xrpc/com.atproto.repo.deleteRecord`,
        {
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            repo: oauthSession.did,
            collection: TAG_COLLECTION,
            rkey,
          }),
        },
      );

      if (!deleteResponse.ok) {
        const errorText = await deleteResponse.text();
        if (deleteResponse.status === 401 || deleteResponse.status === 403) {
          throw Object.assign(
            new Error(`Authentication failed: ${errorText}`),
            { status: deleteResponse.status },
          );
        }
        throw new Error(`Failed to delete tag record: ${errorText}`);
      }

      const result: DeleteTagResponse = { success: true };
      return setSessionCookie(Response.json(result), setCookieHeader);
    } catch (error: any) {
      console.error("Error deleting tag:", error);

      const result: DeleteTagResponse = {
        success: false,
        error: error.message,
      };
      return Response.json(result, { status: 500 });
    }
  });

  return app;
}
