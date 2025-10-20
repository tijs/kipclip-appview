import { createATProtoOAuth } from "jsr:@tijs/atproto-oauth-hono@^0.3.2";
import { DrizzleStorage } from "jsr:@tijs/atproto-oauth-hono@^0.3.2/drizzle";
import { db } from "../database/db.ts";

const BASE_URL = Deno.env.get("BASE_URL") || "https://kipclip-tijs.val.town";
const COOKIE_SECRET = Deno.env.get("COOKIE_SECRET");

if (!COOKIE_SECRET) {
  throw new Error("COOKIE_SECRET environment variable is required");
}

export const oauth = createATProtoOAuth({
  baseUrl: BASE_URL,
  appName: "kipclip",
  cookieSecret: COOKIE_SECRET,
  sessionTtl: 60 * 60 * 24 * 30,
  storage: new DrizzleStorage(db),
});
