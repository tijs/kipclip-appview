/**
 * Test environment setup.
 * Loads .env file if available, otherwise sets test defaults.
 * Import this at the top of test files before importing application code.
 */

import { load } from "jsr:@std/dotenv@0.225";

// Try to load .env file (for local development)
// Fall back to test defaults (for CI/unit tests)
try {
  await load({ export: true });
} catch {
  // .env doesn't exist or failed to load, use test defaults
}

// Ensure required environment variables are set
if (!Deno.env.get("COOKIE_SECRET")) {
  Deno.env.set(
    "COOKIE_SECRET",
    "test-cookie-secret-at-least-32-characters-long-for-testing",
  );
}

if (!Deno.env.get("BASE_URL")) {
  Deno.env.set("BASE_URL", "http://localhost:8000");
}
