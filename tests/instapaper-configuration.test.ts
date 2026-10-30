import { assertEquals } from "@std/assert";

Deno.test("missing encryption key rejects Instapaper setup before external authentication", async () => {
  const child = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--cached-only",
      "-A",
      "--unstable-kv",
      "tests/fixtures/instapaper-no-key.ts",
    ],
    env: {
      ENCRYPTION_KEY: "",
      DATABASE_URL: "file::memory:",
      COOKIE_SECRET: "test-cookie-secret-at-least-32-characters-long",
      KIPCLIP_TESTING: "1",
      KIPCLIP_MANIFEST_PATH: "tests/fixtures/manifest.test.json",
      SENTRY_DSN: "",
    },
    stdout: "piped",
    stderr: "piped",
  });
  const result = await child.output();
  assertEquals(result.code, 0, new TextDecoder().decode(result.stderr));
});
