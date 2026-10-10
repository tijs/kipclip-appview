import "../runtime/deno/install.ts";
import { assert, assertEquals } from "@std/assert";
import { fromFileUrl } from "@std/path";
import { assertIsolated } from "./migration/isolation.ts";

assertIsolated();

for (const scenario of ["lazy", "eager", "gc-failure"]) {
  Deno.test(`migration isolated startup migrations/GC/proxy/OAuth/worker lifecycle ${scenario}`, async () => {
    // Isolated, deterministic temp dir for the child: GitHub runners set no
    // parent TMPDIR, and Deno.Command env values must be strings (undefined
    // fails the spawn with a serde_v8 error).
    const tmp = await Deno.realPath(
      await Deno.makeTempDir({ prefix: "kipclip-migration-startup-" }),
    );
    try {
      const command = new Deno.Command(Deno.execPath(), {
        args: [
          "run",
          "--cached-only",
          "--unstable-kv",
          "--allow-read",
          "--allow-env",
          "--allow-ffi",
          "--deny-net",
          // libsql's native loader calls process.report.getReport() to
          // detect libc flavor; Deno's compatibility layer needs CPU and
          // network-interface system information.
          "--allow-sys=cpus,networkInterfaces",
          fromFileUrl(new URL("./migration/startup-probe.ts", import.meta.url)),
          scenario,
        ],
        cwd: fromFileUrl(new URL("../", import.meta.url)),
        clearEnv: true,
        env: {
          KIPCLIP_TESTING: "1",
          SENTRY_DSN: "",
          DATABASE_URL: "file::memory:",
          KIPCLIP_MANIFEST_PATH: "tests/fixtures/manifest.test.json",
          COOKIE_SECRET: "test-cookie-secret-32-characters-minimum",
          ENCRYPTION_KEY:
            "test-encryption-key-for-unit-tests-only-minimum-32-chars",
          TMPDIR: tmp,
          ...(scenario === "eager"
            ? { BASE_URL: "https://configured.example" }
            : {}),
        },
        stdout: "piped",
        stderr: "piped",
      });
      const output = await command.output();
      const stdout = new TextDecoder().decode(output.stdout);
      const stderr = new TextDecoder().decode(output.stderr);
      assertEquals(output.code, 0, stdout + "\n" + stderr);
      assert(
        !stderr.includes("Download "),
        "Startup probe must use cached dependencies",
      );
      const line = stdout.split("\n").find((line) =>
        line.startsWith("MIGRATION_PROBE ")
      );
      assert(line, stdout);
      const result = JSON.parse(line.slice("MIGRATION_PROBE ".length));
      assertEquals(result.scenario, scenario);
      assertEquals(result.events, ["migrations-complete", "webhook-gc"]);
      assertEquals(result.intervals, [60000, 1234]);
      // Two declared migrations share version005; only14 unique versions apply.
      assertEquals(result.migrations, 14);
    } finally {
      await Deno.remove(tmp, { recursive: true });
    }
  });
}
