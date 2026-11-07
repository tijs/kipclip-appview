import { assertEquals } from "@std/assert";

Deno.test("actual frontend provider, hooks and interaction state contracts", async () => {
  // Components share the existing frontend check: scripts/check-frontend.ts
  // tolerates Deno's TS2875 JSX-runtime type-resolution limitation. Execute
  // them here without suppressing type checks on any backend test.
  const command = new Deno.Command(Deno.execPath(), {
    args: [
      "test",
      "--cached-only",
      "--no-check",
      "-A",
      "tests/frontend/state-contracts.tsx",
    ],
    cwd: new URL("../", import.meta.url),
    stdout: "piped",
    stderr: "piped",
  });
  const output = await command.output();
  const stdout = new TextDecoder().decode(output.stdout);
  const stderr = new TextDecoder().decode(output.stderr);
  assertEquals(output.code, 0, stdout + "\n" + stderr);
  console.log(
    stdout.match(/ok \| .* passed \| .* failed[^\n]*/)?.[0] ?? stdout,
  );
});
