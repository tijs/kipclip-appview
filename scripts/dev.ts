/** Development frontend builder and isolated-host backend watchers. */

const children = [
  new Deno.Command("deno", {
    args: ["run", "-A", "scripts/build-frontend.ts", "--watch"],
    stdout: "inherit",
    stderr: "inherit",
  }).spawn(),
  new Deno.Command("deno", {
    args: [
      "run",
      "-A",
      "--unstable-kv",
      "--watch=routes/,lib/,shared/,runtime/,main.ts,static/",
      "dev.ts",
    ],
    stdout: "inherit",
    stderr: "inherit",
    stdin: "inherit",
  }).spawn(),
];

let shuttingDown = false;
function shutdown(code = 0): never {
  if (!shuttingDown) {
    shuttingDown = true;
    for (const child of children) {
      try {
        child.kill("SIGTERM");
      } catch {
        // already gone
      }
    }
  }
  Deno.exit(code);
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  Deno.addSignalListener(signal, () => shutdown(0));
}

// If either child exits, bring the whole task down so failures are visible
// rather than silently leaving half the dev loop running.
const { code } = await Promise.race(children.map((c) => c.status));
shutdown(code ?? 0);
