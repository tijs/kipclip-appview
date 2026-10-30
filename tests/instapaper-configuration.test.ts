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

Deno.test("a retained encryption key decrypts credentials after a process restart", async () => {
  const script = `
    import "./runtime/deno/install.ts";
    const { encrypt, decrypt } = await import("./lib/encryption.ts");
    const input = await new Response(Deno.stdin.readable).text();
    console.log(Deno.args[0] === "encrypt" ? await encrypt(input) : await decrypt(input));
  `;
  async function run(mode: string, input: string): Promise<string> {
    const child = new Deno.Command(Deno.execPath(), {
      args: ["eval", script, mode],
      env: { ENCRYPTION_KEY: "fixed-test-key-never-used-in-production" },
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    const writer = child.stdin.getWriter();
    await writer.write(new TextEncoder().encode(input));
    await writer.close();
    const result = await child.output();
    assertEquals(result.code, 0, new TextDecoder().decode(result.stderr));
    return new TextDecoder().decode(result.stdout).trimEnd();
  }
  const ciphertext = await run("encrypt", "example-test-password");
  assertEquals(await run("decrypt", ciphertext), "example-test-password");
});
