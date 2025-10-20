import { Hono } from "https://esm.sh/hono";
import type {
  AddTagRequest,
  AddTagResponse,
  DeleteTagResponse,
  EnrichedTag,
  ListTagsResponse,
  UpdateTagRequest,
  UpdateTagResponse,
} from "../../shared/types.ts";
import { getAuthSession, AuthInvalidError, clearSidCookieHeader } from
  "../services/auth.ts";

const TAG_COLLECTION = "com.kipclip.tag";

export const tagsApi = new Hono();

/**
 * Get authenticated user session from OAuth
 * Extracts session cookie and gets OAuth session from storage
 */
// use shared getAuthSession from services/auth.ts

/**
 * List user's tags
 */
tagsApi.get("/tags", async (c) => {
  try {
    const oauthSession = await getAuthSession(c.req.raw);

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
      throw new Error(`Failed to list records: ${await response.text()}`);
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
    return c.json(result);
  } catch (error: any) {
    console.error("Error listing tags:", error);

    if (error instanceof AuthInvalidError) {
      c.header("Set-Cookie", clearSidCookieHeader());
      return c.json({ error: "Authentication invalid" }, 401);
    }

    // If collection doesn't exist yet, return empty array
    if (error.message?.includes("not found") || error.status === 400) {
      return c.json({ tags: [] });
    }

    // If OAuth session temporarily unavailable, return 503 for client to retry
    if (
      error.message?.includes("OAuth session not found") ||
      error.message?.includes("Not authenticated")
    ) {
      return c.json({ error: "Session temporarily unavailable" }, 503);
    }

    return c.json({ error: error.message }, 500);
  }
});

/**
 * Add a new tag
 */
tagsApi.post("/tags", async (c) => {
  try {
    const oauthSession = await getAuthSession(c.req.raw);
    const body: AddTagRequest = await c.req.json();

    if (!body.value || typeof body.value !== "string") {
      return c.json({ error: "Tag value is required" }, 400);
    }

    // Validate tag value
    const value = body.value.trim();
    if (value.length === 0) {
      return c.json({ error: "Tag value cannot be empty" }, 400);
    }
    if (value.length > 64) {
      return c.json({ error: "Tag value must be 64 characters or less" }, 400);
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
      throw new Error(`Failed to create record: ${await response.text()}`);
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

    return c.json(result);
  } catch (error: any) {
    console.error("Error creating tag:", error);
    return c.json({ error: error.message }, 500);
  }
});

/**
 * Update a tag and rename it in all bookmarks
 */
tagsApi.put("/tags/:rkey", async (c) => {
  try {
    const oauthSession = await getAuthSession(c.req.raw);
    const rkey = c.req.param("rkey");
    const body: UpdateTagRequest = await c.req.json();

    if (!body.value || typeof body.value !== "string") {
      return c.json({ error: "Tag value is required" }, 400);
    }

    // Validate tag value
    const newValue = body.value.trim();
    if (newValue.length === 0) {
      return c.json({ error: "Tag value cannot be empty" }, 400);
    }
    if (newValue.length > 64) {
      return c.json({ error: "Tag value must be 64 characters or less" }, 400);
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
      throw new Error(`Failed to get record: ${await getResponse.text()}`);
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

      return c.json({
        success: true,
        tag,
      });
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
      throw new Error(
        `Failed to update tag record: ${await updateResponse.text()}`,
      );
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

    return c.json(result);
  } catch (error: any) {
    console.error("Error updating tag:", error);
    return c.json({ error: error.message }, 500);
  }
});

/**
 * Get tag usage (count of bookmarks using this tag)
 */
tagsApi.get("/tags/:rkey/usage", async (c) => {
  try {
    const oauthSession = await getAuthSession(c.req.raw);
    const rkey = c.req.param("rkey");

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
      throw new Error(`Failed to get tag: ${await getResponse.text()}`);
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
      throw new Error(
        `Failed to list bookmarks: ${await listResponse.text()}`,
      );
    }

    const bookmarksData = await listResponse.json();

    // Count bookmarks that have this tag
    const count = bookmarksData.records.filter((record: any) =>
      record.value.tags?.includes(tagValue)
    ).length;

    return c.json({ count, tagValue });
  } catch (error: any) {
    console.error("Error getting tag usage:", error);
    return c.json({ error: error.message }, 500);
  }
});

/**
 * Delete a tag and remove it from all bookmarks
 */
tagsApi.delete("/tags/:rkey", async (c) => {
  try {
    const oauthSession = await getAuthSession(c.req.raw);
    const rkey = c.req.param("rkey");

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
      throw new Error(`Failed to get tag: ${await getResponse.text()}`);
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
      throw new Error(
        `Failed to delete tag record: ${await deleteResponse.text()}`,
      );
    }

    const result: DeleteTagResponse = { success: true };
    return c.json(result);
  } catch (error: any) {
    console.error("Error deleting tag:", error);
    const result: DeleteTagResponse = {
      success: false,
      error: error.message,
    };
    return c.json(result, 500);
  }
});
