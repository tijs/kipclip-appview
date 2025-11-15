/**
 * Local development server for kipclip.
 * Runs on localhost with real OAuth and local SQLite database.
 *
 * Usage:
 *   1. Copy .env.example to .env
 *   2. Fill in your COOKIE_SECRET
 *   3. Run: deno task dev
 */

import { load } from "jsr:@std/dotenv@0.225";

// Load environment variables from .env file BEFORE importing app
// This ensures index.ts sees the env vars when it initializes
await load({ export: true });

// Now import app after env vars are loaded
// index.ts exports app.fetch as default, so we get the fetch function directly
const { default: appFetch } = await import("./index.ts");

// Get port from environment or use default
const PORT = parseInt(Deno.env.get("PORT") || "8000", 10);

// Verify required environment variables
const BASE_URL = Deno.env.get("BASE_URL");
const COOKIE_SECRET = Deno.env.get("COOKIE_SECRET");

if (!BASE_URL) {
  console.error("❌ BASE_URL environment variable is required");
  console.error("   Copy .env.example to .env and set BASE_URL");
  Deno.exit(1);
}

if (!COOKIE_SECRET) {
  console.error("❌ COOKIE_SECRET environment variable is required");
  console.error("   Generate one with: openssl rand -base64 32");
  Deno.exit(1);
}

console.log("🚀 Starting kipclip local development server...");
console.log(`   BASE_URL: ${BASE_URL}`);
console.log(`   PORT: ${PORT}`);
console.log(`   Database: .local/kipclip.db`);
console.log(`   OAuth: Real ATProto OAuth flow`);
console.log("");

// Start the server
Deno.serve(
  {
    port: PORT,
    hostname: "127.0.0.1",
    onListen: ({ port, hostname }) => {
      console.log(`✅ Server running on http://${hostname}:${port}`);
      console.log("");
      console.log("   Ready for development!");
      console.log("   Press Ctrl+C to stop");
    },
  },
  appFetch,
);
