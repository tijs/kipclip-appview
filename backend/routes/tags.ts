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
import { oauth } from "../index.ts";

const TAG_COLLECTION = "com.kipclip.tag";

export const tagsApi = new Hono();

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
 * Update a tag
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
    const value = body.value.trim();
    if (value.length === 0) {
      return c.json({ error: "Tag value cannot be empty" }, 400);
    }
    if (value.length > 64) {
      return c.json({ error: "Tag value must be 64 characters or less" }, 400);
    }

    // Get current record to preserve createdAt
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

    // Update record using putRecord
    const record = {
      value: value,
      createdAt: currentRecord.value.createdAt, // Preserve original createdAt
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
          collection: TAG_COLLECTION,
          rkey,
          record,
        }),
      },
    );

    if (!response.ok) {
      throw new Error(`Failed to update record: ${await response.text()}`);
    }

    const data = await response.json();

    const tag: EnrichedTag = {
      uri: data.uri,
      cid: data.cid,
      value: value,
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
 * Delete a tag
 */
tagsApi.delete("/tags/:rkey", async (c) => {
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
          collection: TAG_COLLECTION,
          rkey,
        }),
      },
    );

    if (!response.ok) {
      throw new Error(`Failed to delete record: ${await response.text()}`);
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
