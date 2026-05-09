/**
 * Test environment setup.
 * Sets test-mode defaults. Import this at the top of test files before
 * importing application code.
 *
 * Deliberately does NOT load `.env`. The `deno task test` command sets every
 * env var the test path needs (DATABASE_URL, COOKIE_SECRET, etc.), and
 * loading `.env` would only drag in the developer's real SENTRY_DSN and
 * ship test-injected errors to the developer's Sentry project.
 * Tests must never phone home.
 */

// Ensure required environment variables are set
if (!Deno.env.get("COOKIE_SECRET")) {
  Deno.env.set(
    "COOKIE_SECRET",
    "test-cookie-secret-at-least-32-characters-long-for-testing",
  );
}

// Note: BASE_URL is not set here - tests use auto-detection from Request objects

// /api/version + /api/health tests assert against a tracked fixture at
// tests/fixtures/manifest.test.json (committed in-repo). The test task
// exports KIPCLIP_MANIFEST_PATH pointing at it so routes/api/system.ts
// reads the fixture instead of static/manifest.json. This proves the
// manifest read + parse + response shape end-to-end and locks down the
// v0.10.1 silent-FALLBACK regression where every field returned
// "unknown" because the path was wrong. The fixture must be tracked,
// not generated here: ES modules execute in topological order and
// main.ts (which loads system.ts) is independent of this file, so
// loadVersionInfo() can run before any top-level await in test-setup
// completes — a write at this point would race the read.

// Treat the default mock DID as an auto-supporter so tests can exercise
// supporter-gated endpoints without wiring up a supporter record in every
// PDS mock. Tests that specifically assert non-supporter behavior should
// use a DID outside this set.
import { _addTestAutoSupporter } from "../lib/atprotofans.ts";
_addTestAutoSupporter("did:plc:test123");
_addTestAutoSupporter("did:plc:other999");
