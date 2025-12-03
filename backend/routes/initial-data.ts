import type { App } from "jsr:@fresh/core@^2.2.0";

// Fresh App with any state type (we don't use Fresh's state management)
type FreshApp = App<any>;
import type {
  EnrichedBookmark,
  EnrichedTag,
  InitialDataResponse,
} from "../../shared/types.ts";
import {
  getClearSessionCookie,
  getSessionFromRequest,
} from "../utils/session.ts";

const BOOKMARK_COLLECTION = "community.lexicon.bookmarks.bookmark";
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
 * Register initial data routes on the Fresh app
 */
export function registerInitialDataRoutes(app: FreshApp): FreshApp {
  /**
   * Get initial data (bookmarks and tags) in a single request.
   * This avoids the token refresh race condition that can occur when
   * loading bookmarks and tags in parallel from separate API calls.
   */
  app = app.get("/api/initial-data", async (ctx) => {
    try {
      // Get authenticated session once
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

      // Fetch both bookmarks and tags in parallel
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

      // Process bookmarks
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
      } else {
        // If collection doesn't exist yet, that's fine - return empty array
        const errorText = await bookmarksResponse.text();
        if (
          !errorText.includes("not found") && bookmarksResponse.status !== 400
        ) {
          console.error("Error fetching bookmarks:", errorText);
        }
      }

      // Process tags
      let tags: EnrichedTag[] = [];
      if (tagsResponse.ok) {
        const tagsData = await tagsResponse.json();
        tags = tagsData.records.map((record: any) => ({
          uri: record.uri,
          cid: record.cid,
          value: record.value.value,
          createdAt: record.value.createdAt,
        }));
      } else {
        // If collection doesn't exist yet, that's fine - return empty array
        const errorText = await tagsResponse.text();
        if (!errorText.includes("not found") && tagsResponse.status !== 400) {
          console.error("Error fetching tags:", errorText);
        }
      }

      const result: InitialDataResponse = { bookmarks, tags };
      return setSessionCookie(Response.json(result), setCookieHeader);
    } catch (error: any) {
      console.error("Error fetching initial data:", error);
      return Response.json({ error: error.message }, { status: 500 });
    }
  });

  return app;
}
