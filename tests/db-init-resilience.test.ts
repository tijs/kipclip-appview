/**
 * Init resilience: a missing or unreadable LOCAL_DB_URL must NOT crash
 * the boot path. The service should degrade to Turso-only and log a
 * warning.
 *
 * Verified by spawning a Deno subprocess that imports lib/db.ts with a
 * deliberately-bad LOCAL_DB_URL and asserting:
 *   - exit code 0 (boot did not crash)
 *   - localDb resolved to null (fallback path active)
 *   - the warning line was emitted on stderr
 *
 * Subprocess isolation is required because lib/db.ts initializes module
 * state at import time; mutating it from inside a normal test would
 * pollute every other test in the same Deno run.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";

const PROBE_SCRIPT = `
import { localDb } from "../lib/db.ts";
console.log("LOCALDB=" + (localDb === null ? "null" : "set"));
`;

async function runProbe(localDbUrl: string): Promise<{
  code: number;
  stdout: string;
  stderr: string;
}> {
  // Write the probe to a temp file inside the repo so its relative
  // import path resolves predictably from CI and local runs.
  const probePath = await Deno.makeTempFile({
    prefix: "db-init-probe-",
    suffix: ".ts",
    dir: "tests",
  });
  await Deno.writeTextFile(probePath, PROBE_SCRIPT);

  try {
    const cmd = new Deno.Command("deno", {
      args: ["run", "-A", probePath],
      env: {
        // Force non-test mode so the real init path runs.
        TURSO_DATABASE_URL: "file::memory:",
        LOCAL_DB_URL: localDbUrl,
        // Avoid Sentry network noise.
        SENTRY_DSN: "",
        ENVIRONMENT: "DEVELOPMENT",
      },
      stdout: "piped",
      stderr: "piped",
    });
    const { code, stdout, stderr } = await cmd.output();
    return {
      code,
      stdout: new TextDecoder().decode(stdout),
      stderr: new TextDecoder().decode(stderr),
    };
  } finally {
    await Deno.remove(probePath);
  }
}

Deno.test("db init - LOCAL_DB_URL pointing to unreadable path does not crash", async () => {
  // A directory cannot be opened as a SQLite DB. Use the repo root —
  // guaranteed to exist on every checkout.
  const { code, stdout, stderr } = await runProbe("file:./tests");

  assertEquals(code, 0, `boot crashed; stderr=${stderr}`);
  assertStringIncludes(stdout, "LOCALDB=null");
  assertStringIncludes(stderr, "Failed to open local libSQL");
});

Deno.test("db init - LOCAL_DB_URL with bad scheme is ignored cleanly", async () => {
  const { code, stdout, stderr } = await runProbe("libsql://not-a-file");

  assertEquals(code, 0, `boot crashed; stderr=${stderr}`);
  assertStringIncludes(stdout, "LOCALDB=null");
  assertStringIncludes(stderr, "must use file: scheme");
});
