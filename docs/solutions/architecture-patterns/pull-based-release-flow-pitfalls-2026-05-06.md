---
module: deploy/release
date: 2026-05-06
problem_type: architecture_pattern
component: tooling
severity: high
applies_when:
  - "Designing or modifying a pull-based release flow that builds in-place on the production box"
  - "A release script runs from a long-lived working tree it also needs to keep current"
  - "Build-time metadata (version, sha, build timestamp) needs to survive `git archive | tar -x` materialization"
  - "An HTTP endpoint reads a build-time manifest and the cwd is set externally (systemd, docker, ngrok)"
related_components:
  - tooling
  - development_workflow
tags:
  - release-pipeline
  - bash
  - systemd
  - deno
  - manifest
  - self-hosting
  - hetzner
---

# Pull-based release flow — three pitfalls and their fixes

## Context

kipclip-appview moved from operator-laptop `rsync` deploys to a pull-based flow
on a single Hetzner box. A 60s `kipclip-release.timer` polls GitHub for the
latest `v*` tag merged into `origin/main`, builds inside
`/var/lib/kipclip/releases/<tag>/`, and atomic-swaps a `current` symlink. The
first version of this flow shipped as `v0.10.0`. Two patch hotfixes (`v0.10.1`,
`v0.10.2`) followed within hours, both addressing failure modes the original
design did not anticipate.

This doc captures the three durable lessons so the next pull-based pipeline does
not relearn them.

## Guidance

### 1. A self-rewriting bash script must be self-aware

If a deploy script does `git reset --hard origin/main` against the working tree
containing the script itself, bash can splice old bytes (already read) with new
bytes (re-read at the next chunk boundary). This is not theoretical — bash reads
scripts incrementally, not atomically.

Two safe patterns:

**Wrap the script body in a `main()` function** so bash slurps the whole
function definition before invoking it:

```bash
#!/usr/bin/env bash
set -euo pipefail

main() {
  # ... full script body ...
  cd "$SOURCE_DIR"
  git fetch --tags --prune origin "$BRANCH"
  git reset --hard "origin/${BRANCH}"
  # ... rest of release logic ...
}

main "$@"
```

**Or `exec` after the reset** so the new script restarts cleanly:

```bash
git reset --hard "origin/${BRANCH}"
# Re-exec ourselves from the now-current copy
exec "$BASH" "$0" "$@"
```

Prefer `main()` — minimal diff, no infinite-restart risk if a future commit
corrupts the exec path.

The driving incident: `v0.10.1` shipped a fix to `update.sh`, but the running
release timer kept executing the bootstrap-time copy of the file because nothing
reset the source clone's working tree. The `v0.10.2` fix added the reset — and
accidentally introduced the splicing hazard. `v0.10.3` closed it with the
`main()` wrap; this doc captures the rule so the next pipeline lands it on day
one.

### 2. Build-time env vars are the only reliable way to bake metadata into a `git archive`-stripped release dir

The pipeline materializes each tag via
`git archive --format=tar "$TAG" | tar -x -C "$RELEASE_DIR"`. This is
intentional — it keeps the release dir clean of `.git` and avoids a second 300MB
clone per release. But the build script `scripts/build-frontend.ts` had a
fallback that ran `git rev-parse --short HEAD` to discover the sha. In a
`.git`-less release dir, that command fails silently and the manifest writes
`sha: "unknown"`.

The fix: pre-resolve the sha in the source clone (which has `.git`) and pass it
to the build via env var.

```bash
# In update.sh — runs in the source clone where .git exists
RELEASE_SHA="$(git rev-parse --short "$DESIRED_TAG^{commit}")"

(
  cd "$RELEASE_DIR"
  KIPCLIP_VERSION="$DESIRED_TAG" \
    KIPCLIP_SHA="$RELEASE_SHA" \
    "$DENO_BIN" task build
)
```

```typescript
// In scripts/build-frontend.ts — env var first, git fallback for local dev
async function resolveSha(): Promise<string> {
  const fromEnv = Deno.env.get("KIPCLIP_SHA");
  if (fromEnv && fromEnv.trim().length > 0) return fromEnv.trim();
  // Fallback for local `deno task build` runs that have .git available
  try {
    const cmd = new Deno.Command("git", {
      args: ["rev-parse", "--short", "HEAD"],
    });
    // ...
  } catch { /* git not available */ }
  return "unknown";
}
```

Apply this pattern to anything else baked into the build: tag, sha, build
timestamp, branch name, dirty-flag. **If a build script reaches for `git` at
all, it needs an env-var override for the release-dir case.** Ideally drop the
git fallback entirely in production-sensitive paths and require the env var, so
a missing env var is a loud failure rather than `sha: "unknown"`.

### 3. CWD-relative paths in long-running processes are silent landmines

`routes/api/system.ts` originally read the build manifest with
`import.meta.url`-relative resolution, which is robust but resolved relative to
the file's own location (`routes/api/`) — two levels too deep. The `v0.10.1` fix
switched to:

```typescript
const manifestContent = await Deno.readTextFile("static/manifest.json");
```

This works in production (systemd `WorkingDirectory=/var/lib/kipclip/current`)
and in dev (`deno task dev` from repo root) — but only because both happen to
put `static/` directly under cwd. Three landmines in this design:

1. **Silent fallback on cwd mismatch.** If a future systemd unit edit removes
   `WorkingDirectory=`, or a test runner runs from a subdirectory, or someone
   runs `deno run main.ts` from outside the repo, the read fails, the catch
   swallows it, and `/api/version` returns `{version: "unknown"}` with HTTP 200.
   No log, no Sentry event.

2. **Module-load caching freezes the failure.** The result is cached at module
   load (`const versionInfoPromise = loadVersionInfo();`), so a transient
   cold-start race between systemd starting Deno and the symlink swap finalizing
   pins `unknown` for the lifetime of the process. The unit-restart-on-swap
   covers most cases, but a one-off transient leaks to all users.

3. **Tests pass against the broken behavior.** `tests/api-system.test.ts`
   originally asserted only `assertExists(body.version)` — the string
   `"unknown"` satisfies that. The bug shipped because no test pinned
   `body.version !== "unknown"` against a real build.

Three durable practices:

- **Log silent fallbacks.** Never `catch { return FALLBACK; }` without at least
  a `console.warn(err)`. Build-time observability beats post-hoc debugging.
- **Pass paths via env when systemd controls the runtime.** A
  `KIPCLIP_MANIFEST_PATH` env var (set by the systemd unit alongside
  `KIPCLIP_VERSION`) is more honest than a cwd-relative path with an implicit
  contract.
- **Test against real artifacts, not just shape.** The regression test for a
  metadata endpoint should run a known build, then assert exact values — not
  just type/existence.

## Why This Matters

These three pitfalls cost three releases (`v0.10.0`, `v0.10.1`, `v0.10.2`) over
a single afternoon. Each fix shipped via tag, but the second fix could not take
effect until the third one did — the timer was running a frozen copy of
`update.sh`. The chicken-and-egg of self-deploying machinery is that you need
the fix to ship the fix, and "I'll just SSH in once" is the operator-laptop
deploy this whole flow was supposed to replace.

The pattern generalizes: any system that updates itself by pulling its own
update logic from the same source it's trying to update has a class of
bootstrapping bugs that don't surface in normal testing. Design for them up
front (function-wrap, env-var contracts, observability on silent fallbacks) or
pay for them as production hotfixes.

## When to Apply

- Designing a new pull-based release pipeline that builds in-place on the target
  host
- Adopting a `git archive`-based materialization that strips `.git` from the
  build dir
- Adding a build-metadata HTTP endpoint that depends on a manifest file
- Reviewing any deploy script that does `git reset --hard` against its own
  working tree
- Reviewing any long-running Deno/Node service that reads a config file with a
  relative path

## Examples

The driving incidents in chronological order:

| Tag       | Bug                                                                         | Root cause                                                                                                           | Fix                                                                                                                                                |
| --------- | --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `v0.10.0` | Initial pull-based flow                                                     | n/a                                                                                                                  | new pipeline shipped                                                                                                                               |
| `v0.10.1` | `/api/version` returned `unknown`; manifest sha was `unknown` in production | (a) `import.meta.url`-relative path resolved two dirs too deep; (b) `git rev-parse` ran in a `.git`-less release dir | (a) cwd-relative read; (b) `KIPCLIP_SHA` env var pre-resolved in source clone                                                                      |
| `v0.10.2` | `v0.10.1`'s fix never reached the box                                       | source clone working tree was frozen at bootstrap-time commit                                                        | added `git reset --hard origin/main` to `update.sh` self-sync (introduced the splicing hazard for next time)                                       |
| `v0.10.3` | Splicing hazard from `v0.10.2`; silent FALLBACK gap from `v0.10.1`          | (a) bash reads scripts incrementally; (b) `loadVersionInfo()` swallowed errors and tests asserted only field shape   | (a) `main()` wrap on `update.sh`; (b) `console.warn` in catch + `KIPCLIP_MANIFEST_PATH` env override + tracked test fixture asserting exact values |

Future iterations should still land:

1. Drop the git fallback in `resolveSha()` entirely (require `KIPCLIP_SHA` env
   in release builds) or warn loudly when it fires in non-dev cwd — current
   fallback masks env-var regressions.
2. Health-check rollback: `update.sh` line ~190 leaves the `current` symlink on
   the new release if health-check fails. Either revert the symlink, or set a
   dirty-flag and surface it in `/api/health`.
