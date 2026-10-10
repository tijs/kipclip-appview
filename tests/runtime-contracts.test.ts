import "../runtime/deno/install.ts";
import { assertEquals } from "@std/assert";

Deno.test("portable contract suite runs against actual isolated Deno adapter", async () => {
  const scratch = Deno.realPathSync(
    Deno.env.get("TMPDIR") ??
      Deno.makeTempDirSync({ prefix: "kipclip-runtime-test-" }),
  );
  const result = await new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--cached-only",
      "--allow-env",
      "--allow-read",
      `--allow-write=${scratch}`,
      "--allow-ffi",
      "--allow-net=127.0.0.1",
      // libsql's native loader calls process.report.getReport() to detect
      // libc flavor; Deno's compatibility layer needs CPU and
      // network-interface system information.
      "--allow-sys=cpus,networkInterfaces",
      "--unstable-kv",
      "tests/runtime/contracts.mjs",
    ],
    clearEnv: true,
    env: {
      TMPDIR: scratch,
      PATH: Deno.env.get("PATH") ?? "",
      HOME: Deno.env.get("HOME") ?? "",
    },
    stdout: "piped",
    stderr: "piped",
  }).output();
  const stdout = new TextDecoder().decode(result.stdout);
  const stderr = new TextDecoder().decode(result.stderr);
  assertEquals(result.code, 0, stdout + stderr);
  const report = JSON.parse(
    stdout.split("\n").find((line) => line.startsWith("RUNTIME_RESULT "))!
      .slice(15),
  );
  assertEquals(report.runtime, "deno");
  assertEquals(report.passed, 47);
  assertEquals(report.failed, 0);
});
