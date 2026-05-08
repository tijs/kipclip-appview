/**
 * Init resilience: a missing or unreadable TURSO_DATABASE_URL must NOT crash
 * the boot path. The service should degrade to primary-only and log a
 * warning.
 *
 * Verified by spawning a Deno subprocess that imports lib/db.ts with a
 * deliberately-bad TURSO_DATABASE_URL and asserting:
 *   - exit code 0 (boot did not crash)
 *   - remoteDb resolved to null (fallback path active)
 *   - the warning line was emitted on stderr
 *
 * Subprocess isolation is required because lib/db.ts initializes module
 * state at import time; mutating it from inside a normal test would
 * pollute every other test in the same Deno run.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";

const PROBE_SCRIPT = `
import { remoteDb } from "../lib/db.ts";
console.log("REMOTEDB=" + (remoteDb === null ? "null" : "set"));
`;

async function runProbe(remoteDbUrl: string): Promise<{
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
        DATABASE_URL: "file::memory:",
        TURSO_DATABASE_URL: remoteDbUrl,
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

Deno.test("db init - TURSO_DATABASE_URL with file: scheme is ignored cleanly", async () => {
  // file: scheme for TURSO_DATABASE_URL is rejected — it must be a remote URL.
  const { code, stdout, stderr } = await runProbe("file:./some-local-path.db");

  assertEquals(code, 0, `boot crashed; stderr=${stderr}`);
  assertStringIncludes(stdout, "REMOTEDB=null");
  assertStringIncludes(stderr, "must use a remote URL");
});
