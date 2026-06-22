/**
 * Dev orchestrator.
 *
 * Runs two long-lived watchers together so a single `deno task dev` gives a
 * full hot-reload loop:
 *
 *   1. Frontend bundle watcher — `build-frontend.ts --watch` rebuilds the
 *      esbuild SPA bundle (static/bundle.<hash>.js) whenever frontend/ or
 *      shared/ change. This is the piece Fresh does NOT do for us: the SPA is
 *      a custom esbuild bundle served as a static asset, outside Fresh's own
 *      island/route pipeline, so Fresh's built-in dev bundling never touches
 *      it. Without this watcher the bundle is built once and goes stale.
 *
 *   2. Fresh server — restarts on server-side changes (routes/, lib/, shared/,
 *      main.ts). It does NOT watch static/: the bundle name + SRI are read
 *      from static/manifest.json per request (lib/file-server.ts, uncached),
 *      so a frontend rebuild is picked up on the next page load without a
 *      server restart.
 *
 * Kill the task (Ctrl-C) and both children are torn down.
 */

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
      "--watch=routes/,lib/,shared/,main.ts",
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
