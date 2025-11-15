import { db, rawDb } from "./backend/database/db.ts";
import { DrizzleStorage } from "jsr:@tijs/atproto-oauth-hono@2.0.7/drizzle";

const storage = new DrizzleStorage(db);
const key = 'pkce:{"handle":"tijs.org","timestamp":1763225600586}';

console.log("Testing retrieval for:", key);
console.log("Current time (seconds):", Math.floor(Date.now() / 1000));

// First test raw SQL
console.log("\n1. Testing raw SQL:");
const rawResult = await rawDb.execute({
  sql: "SELECT value FROM iron_session_storage WHERE key = ? AND (expires_at IS NULL OR expires_at > ?)",
  args: [key, Math.floor(Date.now() / 1000)],
});
console.log("Raw result rows:", rawResult.rows);

// Then test DrizzleStorage
console.log("\n2. Testing DrizzleStorage:");
const result = await storage.get(key);
console.log("Result:", result ? "✅ FOUND" : "❌ NOT FOUND");
if (result) console.log(JSON.stringify(result, null, 2));
