/** Mock only the remote OAuth-client boundary; handlers/cookies/SQLite stay real. */
import { OAuthClient } from "@tijs/oauth-client-deno";
import { SessionManager } from "@tijs/atproto-sessions";
import { assert, assertEquals } from "@std/assert";
import { createMockSession } from "../test-helpers.ts";
import { OAUTH_SCOPES } from "../../lib/oauth-scopes.ts";
import { withMockFetch } from "./isolation.ts";

export const fixtureDid = "did:plc:migrationfixture";
export const fixtureSession = {
  ...createMockSession({
    did: fixtureDid,
    handle: "alice.example",
    pdsUrl: "",
  }),
  toJSON: () => ({ did: fixtureDid, handle: "alice.example", fixture: true }),
};

export function cookieManager(): SessionManager {
  return new SessionManager({
    cookieSecret: Deno.env.get("COOKIE_SECRET")!,
    sessionTtl: 60 * 60 * 24 * 14,
    cookieName: "sid",
  });
}

export async function assertEncryptedCookie(
  cookie: string | null,
): Promise<string> {
  assert(cookie);
  assertEquals(cookie.split("; ").slice(1), [
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Secure",
    "Max-Age=1209600",
  ]);
  assert(
    !cookie.includes(fixtureDid),
    "DID must not be readable in wire cookie",
  );
  const pair = cookie.split(";")[0];
  const decoded = await cookieManager().getSessionFromRequest(
    new Request("https://migration.example", { headers: { cookie: pair } }),
  );
  assertEquals(decoded.data?.did, fixtureDid);
  assert(typeof decoded.data?.createdAt === "number");
  assert(typeof decoded.data?.lastAccessed === "number");
  return pair;
}

export interface OAuthCalls {
  authorize: { handle: string; options: any }[];
  callback: string[];
  restore: string[];
}

export async function withOAuthBoundary<T>(
  run: (calls: OAuthCalls) => Promise<T>,
  errors: {
    authorize?: Error;
    callback?: Error;
    restore?: Error;
    missing?: boolean;
  } = {},
): Promise<T> {
  const prototype = OAuthClient.prototype;
  const saved = {
    authorize: prototype.authorize,
    callback: prototype.callback,
    restore: prototype.restore,
  };
  const calls: OAuthCalls = { authorize: [], callback: [], restore: [] };
  prototype.authorize = (handle, options) => {
    calls.authorize.push({ handle, options });
    assertEquals(options?.scope, OAUTH_SCOPES);
    return errors.authorize
      ? Promise.reject(errors.authorize)
      : Promise.resolve(new URL("https://auth.example/authorize?fixture=true"));
  };
  prototype.callback = (params) => {
    calls.callback.push(params.toString());
    return errors.callback ? Promise.reject(errors.callback) : Promise.resolve({
      session: fixtureSession as any,
      state: params.get("state"),
    });
  };
  prototype.restore = (did) => {
    calls.restore.push(did);
    return errors.restore
      ? Promise.reject(errors.restore)
      : Promise.resolve(errors.missing ? null : fixtureSession as any);
  };
  try {
    return await withMockFetch((request) => {
      throw new Error(`OAuth test attempted unexpected fetch: ${request.url}`);
    }, () => run(calls));
  } finally {
    Object.assign(prototype, saved);
  }
}
