/**
 * One-time migration: convert hex-format rkeys to AT Protocol TIDs.
 *
 * Two endpoints:
 *   POST /api/migrate-hex-rkeys/plan   — scan bookmarks, return migration plan
 *   POST /api/migrate-hex-rkeys/batch  — execute one batch of N migrations
 *
 * The client script drives the migration by calling plan once, then batch
 * repeatedly until done. This avoids HTTP timeout issues with long-running
 * requests.
 */

import type { App } from "@fresh/core";
import {
  ANNOTATION_COLLECTION,
  BOOKMARK_COLLECTION,
  createAuthErrorResponse,
  getSessionFromRequest,
  listAllRecords,
  setSessionCookie,
} from "../../lib/route-utils.ts";
import { generateTidForTimestamp } from "../../lib/tid.ts";

const HEX_RKEY_RE = /^[0-9a-f]{13}$/;

function extractRkey(uri: string): string {
  return uri.split("/").pop()!;
}

export function registerMigrateHexRkeysRoute(app: App<any>): App<any> {
  // Plan: scan for hex rkeys and return the migration plan
  app = app.post("/api/migrate-hex-rkeys/plan", async (ctx) => {
    const { session: oauthSession, setCookieHeader, error } =
      await getSessionFromRequest(ctx.req);
    if (!oauthSession) return createAuthErrorResponse(error);

    const bookmarks = await listAllRecords(
      oauthSession,
      BOOKMARK_COLLECTION,
    );

    const hexBookmarks = bookmarks.filter((b: any) =>
      HEX_RKEY_RE.test(extractRkey(b.uri))
    );
    const tidRkeys = new Set(
      bookmarks
        .filter((b: any) => !HEX_RKEY_RE.test(extractRkey(b.uri)))
        .map((b: any) => extractRkey(b.uri)),
    );

    // Generate TID rkeys for all hex bookmarks
    const usedRkeys = new Set(tidRkeys);
    const plan = hexBookmarks.map((bookmark: any) => {
      const oldRkey = extractRkey(bookmark.uri);
      const createdAt = bookmark.value.createdAt;
      let newRkey = generateTidForTimestamp(new Date(createdAt));
      while (usedRkeys.has(newRkey)) {
        newRkey = generateTidForTimestamp(new Date(createdAt));
      }
      usedRkeys.add(newRkey);
      return { oldRkey, newRkey, createdAt };
    });

    return setSessionCookie(
      Response.json({
        total: bookmarks.length,
        hexCount: hexBookmarks.length,
        tidCount: tidRkeys.size,
        plan,
      }),
      setCookieHeader,
    );
  });

  // Batch: execute a batch of rkey migrations
  app = app.post("/api/migrate-hex-rkeys/batch", async (ctx) => {
    const { session: oauthSession, setCookieHeader, error } =
      await getSessionFromRequest(ctx.req);
    if (!oauthSession) return createAuthErrorResponse(error);

    const body = await ctx.req.json();
    const items: { oldRkey: string; newRkey: string }[] = body.items;

    if (!items?.length) {
      return Response.json({ error: "No items provided" }, { status: 400 });
    }

    const pdsUrl = oauthSession.pdsUrl;
    const did = oauthSession.did;
    const writes: any[] = [];

    // For each item, build create+delete ops
    for (const item of items) {
      // Get old bookmark
      const bkParams = new URLSearchParams({
        repo: did,
        collection: BOOKMARK_COLLECTION,
        rkey: item.oldRkey,
      });
      const bkRes = await oauthSession.makeRequest(
        "GET",
        `${pdsUrl}/xrpc/com.atproto.repo.getRecord?${bkParams}`,
      );
      if (!bkRes.ok) continue; // Already migrated or missing
      const bkRecord = await bkRes.json();

      // Create new bookmark with clean value
      const bookmarkValue: Record<string, unknown> = {
        subject: bkRecord.value.subject,
        createdAt: bkRecord.value.createdAt,
      };
      if (bkRecord.value.tags?.length > 0) {
        bookmarkValue.tags = bkRecord.value.tags;
      }

      writes.push({
        $type: "com.atproto.repo.applyWrites#create",
        collection: BOOKMARK_COLLECTION,
        rkey: item.newRkey,
        value: bookmarkValue,
      });

      // Check for annotation sidecar
      const annParams = new URLSearchParams({
        repo: did,
        collection: ANNOTATION_COLLECTION,
        rkey: item.oldRkey,
      });
      const annRes = await oauthSession.makeRequest(
        "GET",
        `${pdsUrl}/xrpc/com.atproto.repo.getRecord?${annParams}`,
      );
      if (annRes.ok) {
        const annRecord = await annRes.json();
        const newUri = `at://${did}/${BOOKMARK_COLLECTION}/${item.newRkey}`;
        const annValue: Record<string, unknown> = {
          subject: newUri,
          createdAt: annRecord.value.createdAt,
        };
        for (
          const key of ["title", "description", "favicon", "image", "note"]
        ) {
          if (annRecord.value[key]) annValue[key] = annRecord.value[key];
        }
        writes.push({
          $type: "com.atproto.repo.applyWrites#create",
          collection: ANNOTATION_COLLECTION,
          rkey: item.newRkey,
          value: annValue,
        });
        writes.push({
          $type: "com.atproto.repo.applyWrites#delete",
          collection: ANNOTATION_COLLECTION,
          rkey: item.oldRkey,
        });
      }

      // Delete old bookmark
      writes.push({
        $type: "com.atproto.repo.applyWrites#delete",
        collection: BOOKMARK_COLLECTION,
        rkey: item.oldRkey,
      });
    }

    if (writes.length === 0) {
      return setSessionCookie(
        Response.json({ migrated: 0, skipped: items.length }),
        setCookieHeader,
      );
    }

    // Execute
    const res = await oauthSession.makeRequest(
      "POST",
      `${pdsUrl}/xrpc/com.atproto.repo.applyWrites`,
      {
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repo: did, writes }),
      },
    );

    if (res.ok) {
      return setSessionCookie(
        Response.json({ migrated: items.length, writes: writes.length }),
        setCookieHeader,
      );
    }

    if (res.status === 429) {
      const retryAfter = res.headers.get("retry-after");
      return setSessionCookie(
        Response.json({ rateLimited: true, retryAfter }, { status: 429 }),
        setCookieHeader,
      );
    }

    const errorText = await res.text();
    return setSessionCookie(
      Response.json({ error: errorText }, { status: 500 }),
      setCookieHeader,
    );
  });

  return app;
}
