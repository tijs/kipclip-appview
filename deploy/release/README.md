# Pull-based release runbook

This is the operator runbook for releasing kipclip on the Hetzner box. The box
pulls semver `v*` git tags from GitHub on a 60s timer and swaps the `current`
symlink atomically.

## Standard release

From any machine with push perms (no operator-laptop state required):

```bash
# 1. Update CHANGELOG.md — move [Unreleased] entries into a new
#    [vX.Y.Z] - YYYY-MM-DD section.
git add CHANGELOG.md
git commit -m "chore: prepare vX.Y.Z release notes"

# 2. Annotated tag — message is a one-line description shown in
#    `git tag -n` and on GitHub releases.
git tag -a vX.Y.Z -m "vX.Y.Z - Short description"

# 3. Push commit + tags.
git push origin main --tags
```

Within ~60s the box's `kipclip-release.timer` fires, `update.sh` notices the new
tag, builds in `/var/lib/kipclip/releases/vX.Y.Z/`, atomic-swaps `current`,
restarts `kipclip`, and health-checks the new process.

The **first Hono release** instead goes through the runtime-cutover transaction
described below (with its own ordering and timer notes).

Verify:

```bash
curl https://kipclip.com/api/version
# { "version": "vX.Y.Z" }
# (sha + builtAt are operator-only since v0.12.0; ssh and read
# /var/lib/kipclip/current/static/manifest.json for the full set)

ssh kipclip-box "journalctl -u kipclip-release.service -n 30 --no-pager"
```

The frontend footer shows the running tag and links to the GitHub release page.

## First Hono release (runtime cutover)

The box's base unit is bootstrap-managed and, until bootstrap re-runs, starts
the legacy runtime. A Hono tag alone would fail health under it, and running
bootstrap early would install the new base unit while the active release is
still legacy. `update.sh` therefore treats a change of runtime kind as one
cutover transaction:

- the release is staged and built while `current` still points at the old
  release — a failed build changes nothing;
- a durable activation journal (see "Crash recovery" below) is committed under
  `/var/lib/kipclip/.release-txn/` with byte-exact copies of both drop-ins;
- the `release.conf` drop-in (SENTRY_RELEASE) and, when the runtime kind
  changes, the `runtime.conf` drop-in (which resets the base `ExecStart` and
  pins the entrypoint for the new runtime kind) are written,
  `systemctl daemon-reload` runs, `current` is swapped, and the service restarts
  exactly once — symlink and unit move together;
- if a drop-in write, the `daemon-reload`, the swap, the restart, or the
  `/api/health` check fails, the previous `current` symlink AND both drop-ins
  are restored byte-exactly (a drop-in that did not exist before the tick is
  removed), systemd is reloaded, the old release is restarted, and its health is
  re-verified before the tick exits 1;
- the journal is removed only after that verified rollback (or a verified
  activation). If the rollback itself cannot be verified, the journal is kept
  and later ticks stop at recovery (fail closed) until an operator resolves it.

Same-kind updates (later Hono releases, plain legacy releases) keep the
swap-only path: symlink + restart, no unit change.

Pinning back to a pre-Hono tag is **base-unit-aware**: the updater reads the
installed base unit's `ExecStart` (`update.sh` never writes base units —
bootstrap is the only writer):

- base unit legacy → the `runtime.conf` override is removed and the base unit
  applies again (the pre-bootstrap case);
- base unit Hono (a bootstrap-redo already happened) → removing the override
  would leave a Hono `ExecStart` pointing at a legacy tree, so an explicit
  legacy override is pinned instead (the pre-Hono base command:
  `deno serve -A --host 127.0.0.1 --port 8000` on the generated entrypoint,
  written here as `_` + `fresh/server.js` so the framework audit stays
  fail-closed);
- base unit unreadable or unrecognised → the tick exits 1 **before any
  mutation**. Recoverable path: `ssh kipclip-box "systemctl cat kipclip"`,
  verify `/etc/systemd/system/kipclip.service` is the bootstrap-managed unit and
  re-run `deploy/release/bootstrap.sh` if not; the next 60s tick then retries
  automatically.

### Do not run bootstrap before the cutover

`deploy/release/bootstrap.sh` is the only writer of the base units, and the base
unit it installs is the **Hono** one. Running it while `current` still points at
a pre-Hono release therefore installs a Hono base unit that cannot start the
legacy release `current` points at:

- bootstrap's synchronous first-release step fails loudly: the tick exits 1 at
  the no-journal consistency guard
  (`unit/current mismatch with no activation
  journal`) and bootstrap reports
  `first release run failed`;
- every 60s tick keeps failing closed at the same guard until the unit and
  `current` agree again;
- the app keeps serving only because systemd still runs the old process — the
  next kipclip restart (crash, reboot) would start the Hono entrypoint against
  the legacy tree and take the app down.

If it has happened anyway, the supported unblock is to restore the pre-Hono
`ExecStart` override so the unit matches `current`; the next tick then passes
the guard and runs the Hono cutover transaction normally (which snapshots the
override and rewrites it to pin the Hono entrypoint):

```bash
ssh kipclip-box
# Pre-Hono entrypoint, assembled from fragments so this runbook stays audit-clean:
ENTRY="_"; ENTRY="${ENTRY}fresh/server.js"
sudo -u kipclip tee /etc/systemd/system/kipclip.service.d/runtime.conf >/dev/null <<EOF
[Service]
ExecStart=
ExecStart=/opt/deno/bin/deno serve -A --host 127.0.0.1 --port 8000 ${ENTRY}
EOF
sudo systemctl daemon-reload
```

Write it as the `kipclip` user (the drop-in directory's owner): `update.sh` runs
as `kipclip` and must be able to rewrite the override when the cutover tick
replaces it. Then watch the next tick:

```bash
ssh kipclip-box "journalctl -u kipclip-release.service -n 30 --no-pager"
```

The rest of the interrupted bootstrap run (units, Caddyfile, timers) was already
applied; once the cutover has completed, re-run bootstrap to finish its
remaining steps cleanly.

The transaction and its recovery paths are pinned offline by
`tests/shell/update.test.sh` (stubbed sudo/systemctl/curl/ln/sync, temp dirs
only; 28 scenarios incl. SIGKILL at each mutation point, a failing journal sync,
the no-journal consistency guard, and flock contention). It runs in CI
(`.github/workflows/test.yml`) and locally: `bash tests/shell/update.test.sh`.

### Crash recovery (activation journal)

A shell `EXIT` trap cannot run on `SIGKILL` or power loss, so recovery does not
rely on one. Before the first mutation each tick commits a journal to
`/var/lib/kipclip/.release-txn/` (the same filesystem as `current`; never
`/tmp`, which is not durable): the target release, the previous `current`
target, and byte-exact copies of both drop-ins. On the next tick — **before**
the "desired == current, nothing to do" fast-path can exit — an existing journal
means the previous tick died mid-transaction:

- `current` already points at the journal's target → the swap happened; recovery
  restarts the unit and health-checks it (the only way to prove the new release
  actually starts), then removes the journal — or rolls back if it cannot be
  verified. One extra restart is the expected cost of a crash.
- `current` does not point at the target → the swap never happened; recovery
  restores the drop-ins byte-exactly, reloads systemd, removes the journal, and
  lets the normal flow retry the release.
- the journal is corrupt or a rollback cannot be verified → fail closed: the
  journal stays, the tick exits 1, and later ticks keep stopping at recovery
  until an operator resolves it (the journal path is named in the log line).

Residual risk, stated honestly and without calling it bounded: a `sync` failure
is fail-closed — the tick exits 1 before any mutation. What cannot be ruled out
is storage that reports a successful `sync` and then still loses the journal
while a drop-in mutation persisted. The next tick then has no journal to recover
from; immediately after recovery — before the fetch, the build, or any
transaction that could snapshot the stale drop-in — the no-journal consistency
guard checks every valid `current` symlink and fails closed (exit 1, with the
operator checks named in the log) when:

- the unit's effective `ExecStart` kind cannot be determined (missing or
  unrecognised base unit / override), or disagrees with the release `current`
  points at — including on the desired==current fast-path, which must not exit
  "nothing to do" over a unit that cannot start its own release;
- release.conf `SENTRY_RELEASE` disagrees with (or cannot be read from) the
  current release's `.version` — a same-kind crash leaves the unit kind
  consistent, so the label is the only evidence left.

The intentional legacy → Hono cutover is unaffected: a legacy `current` under a
legacy effective unit agrees, and the cutover transaction proceeds. What stays
undetectable is a lost journal whose persisted state is fully self-consistent
(e.g. the swap completed but the restart was never proven): the next tick then
treats the release as already active. Operator-blocking where detectable, never
silent, and there is no pretence of full crash atomicity.

### Ordering for the first Hono release

The release timer runs `update.sh` from the source clone, and each tick
hard-resets that clone to `origin/main` before resolving tags — but the running
tick still executes the updater it parsed at start. Every tick therefore logs
which revision it is, **before** the reset can touch the checkout:

```text
==> Updater revision: commit=<source HEAD> update.sh-sha256=<hash of the running update.sh>
```

So:

1. Merge the release to `main` (the updated `update.sh` ships in the same
   merge).
2. Wait until a tick reports the merge commit in that line — the first tick
   after the merge still ran the old updater; the next one parses and runs the
   new bytes. Verify against the checkout on the box:

   ```bash
   ssh kipclip-box "journalctl -u kipclip-release.service -n 30 --no-pager | grep 'Updater revision'"
   ssh kipclip-box "git -C /var/lib/kipclip/source log -1 --format='%H %s'"
   ```

3. Only then push the annotated tag. The next tick stages the Hono release, runs
   the cutover, and health-checks it.

### Timer serialization

Ticks serialize on `/var/lib/kipclip/.release-lock` (`flock -n`): a tick that
finds the lock held exits 0 silently, so a long build or a cutover spans exactly
one tick and overlapping timer firings are skipped. The whole cutover — drop-in
writes, `daemon-reload`, swap, restart, health check, or the rollback — runs
inside one locked tick, so the unit and the symlink can never be switched by two
overlapping runs. Don't start `kipclip-release.service` manually while a tick
may be in flight; `flock` makes one of the two a silent no-op.

## Pin override (incident, manual rollback)

To stop the box from auto-rolling forward:

```bash
ssh kipclip-box
echo "vX.Y.Z" | sudo tee /etc/kipclip/release-pin
```

The next timer tick reads the pin file and stays on (or rolls back to) `vX.Y.Z`.
The pin survives reboots. Read it back and watch the next tick act on it:

```bash
ssh kipclip-box "cat /etc/kipclip/release-pin"
ssh kipclip-box "journalctl -u kipclip-release.service -n 20 --no-pager"
curl https://kipclip.com/api/version   # flips once the pinned release is active
```

**Without a pin, failed tags are retried on every 60s tick.** A tag that fails
to build or health-check rolls back automatically (see "Rollback"), and the next
tick picks the same latest tag again — the retry loop is by design. Pin the
previous good tag to stop it.

To unpin:

```bash
ssh kipclip-box "sudo rm /etc/kipclip/release-pin"
```

The next tick picks the latest semver tag merged into `origin/main`.

## Rollback

Two options:

- **Pin to the previous tag.** Recommended — no force-push, no history rewrite.
  Write the pin, read it back, then watch the next tick:

  ```bash
  ssh kipclip-box "echo vX.Y.Z-1 | sudo tee /etc/kipclip/release-pin && cat /etc/kipclip/release-pin"
  ssh kipclip-box "journalctl -u kipclip-release.service -n 20 --no-pager"
  curl https://kipclip.com/api/version
  ```

- **Move the `release` candidate by re-tagging.** Force-push only as a last
  resort, and only if the bad tag has not been advertised.

A failed release rolls back automatically before the tick exits: the previous
`current` symlink and both drop-ins are restored, systemd is reloaded, and the
old release is restarted and health-verified. If that rollback cannot be
verified, the tick keeps the activation journal and fails closed — the log line
names the journal path an operator must inspect, and later ticks keep stopping
at recovery until it is resolved (see "Crash recovery").

A manual pin to a pre-Hono tag after the cutover switches the runtime back by
the same base-unit-aware transaction on the next tick. Remember that without a
pin the timer retries the failed latest tag every 60s: pin first, then fix
forward.

## Bootstrap-redo (config changes)

**Do not run this before the first Hono cutover has completed** — while
`current` still points at a pre-Hono release, this installs the Hono base unit
immediately and the release flow then fails closed until the unit and `current`
agree again. See "Do not run bootstrap before the cutover" above for the
mechanism and the supported recovery.

When `deploy/Caddyfile`, `deploy/systemd/*.service`,
`deploy/release/*.{service,timer,rules}`, or `deploy/release/kipclip.sudoers`
need to update (e.g. the `wss://kipclip.com` connect-src entry that the
`/api/live` WebSocket needs in CSP):

```bash
ssh kipclip-box "cd /var/lib/kipclip/source && sudo git pull && \
  sudo bash deploy/release/bootstrap.sh"
```

This is the only path that writes the base units, the Caddyfile, or
`/etc/sudoers.d/`. The 60s auto-release flow only manages drop-ins inside
`/etc/systemd/system/kipclip.service.d/` (`release.conf` every swap;
`runtime.conf` only when the release runtime kind changes) — it never rewrites
the base units, which is the structural fix that prevents the phase 4
Caddyfile-clobber bug recurring.

## TAP webhook shared secret

`worker/webhook.ts` enforces an Authorization-header check when
`TAP_ADMIN_PASSWORD` is set on kipclip. Two header shapes accepted:

- `Basic admin:<secret>` — what TAP currently sends (it reuses
  `TAP_ADMIN_PASSWORD` for outbound webhook auth via
  `cmd/tap/webhook_client.go`).
- `Bearer <secret>` — forward-compat for a future TAP that decouples outbound
  webhook auth from admin auth.

Defense-in-depth behind Caddy `respond @hook 403` and the app-layer
`ipFilter({ allowList: ["127.0.0.1", "::1"] })` middleware (registered inside
`registerSyncRoutes` in `routes/api/sync.ts`).

Defence layers in effect on the box:

1. **Caddy** — `respond @hook 403` on every public host. External traffic never
   reaches the app.
2. **App ipFilter** — rejects any connecting peer that is not `127.0.0.1` or
   `::1`. On the box, Caddy proxies external traffic to localhost, so all
   requests reaching the app appear as `127.0.0.1`. **The ipFilter cannot
   distinguish TAP from a Caddy-forwarded user request on the box** — that is
   what the Basic-auth secret check is for.
3. **Basic-auth secret** — the actual TAP-vs-user gate on the box. Both sides
   read from `TAP_ADMIN_PASSWORD`.

Rollout (both sides read `TAP_ADMIN_PASSWORD` — rotating it affects TAP's
inbound API auth and outbound webhook auth at the same time):

1. Generate a 32+-char secret: `openssl rand -hex 32`
2. On the box, set `TAP_ADMIN_PASSWORD=<secret>` in both `/etc/tap/env` and
   `/etc/kipclip/env` to the same value.
3. Restart both services: `sudo systemctl restart tap kipclip` (TAP must restart
   first so the next webhook delivery carries the new password; if kipclip
   restarts first and TAP hasn't picked up the new secret, every webhook 401s
   for the gap).
4. Verify in journalctl: `journalctl -u kipclip -n 20 | grep webhook` should NOT
   show "TAP_ADMIN_PASSWORD not set" warning. TAP's outbound webhook delivery
   should succeed (no retries piling up).

Until both sides are configured, leave both unset. kipclip's check is
env-var-gated — unset env = no check, current behavior preserved.

## Env file permissions audit

`deploy/release/check-env-perms.sh` verifies that `/etc/kipclip/env`,
`/etc/kipclip/restic.env`, and `/etc/tap/env` have the expected ownership and
mode. `bootstrap.sh` runs it at the end of bootstrap; an operator can re-run it
on demand:

```bash
ssh kipclip-box "sudo /var/lib/kipclip/source/deploy/release/check-env-perms.sh"
```

A failure exits 1 with the offending file(s) named. Common cause: the operator
edited an env file with `sudo vi` and the new file inherited the editor's umask,
dropping `kipclip` group access. Fix:
`sudo chown root:kipclip /etc/kipclip/env && sudo chmod 0640 /etc/kipclip/env`.

## What lives where on the box

| Path                                                 | Owner        | Purpose                                                                                                                                                                              |
| ---------------------------------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `/var/lib/kipclip/source/`                           | kipclip      | Pull-source git clone. `update.sh` runs `git fetch` here every 60s.                                                                                                                  |
| `/var/lib/kipclip/releases/<tag>/`                   | kipclip      | Materialised release trees. Last 5 retained, older GC'd.                                                                                                                             |
| `/var/lib/kipclip/current`                           | kipclip      | Symlink to the running release dir. `kipclip.service` resolves through this.                                                                                                         |
| `/var/lib/kipclip/mirror.db`                         | kipclip      | Local libSQL mirror. Outside release dirs — survives swaps.                                                                                                                          |
| `/var/lib/kipclip/.release-txn/`                     | kipclip      | Durable activation journal: pending transaction + byte-exact drop-in snapshots. Exists only between a mutation and its verified completion/rollback.                                 |
| `/etc/kipclip/env`                                   | root:kipclip | App env file (`0640`). Bootstrap-managed (never written by `update.sh`).                                                                                                             |
| `/etc/kipclip/restic.env`                            | root         | Restic backup credentials (`0600`). Bootstrap-managed.                                                                                                                               |
| `/etc/kipclip/release-pin`                           | root:kipclip | Optional pin override (a single tag, `0644`). Empty/missing = use latest.                                                                                                            |
| `/etc/tap/env`                                       | root:tap     | TAP env file (`0640`). Bootstrap-managed.                                                                                                                                            |
| `/etc/systemd/system/kipclip.service.d/release.conf` | kipclip      | Drop-in written by `update.sh` at swap time, holding `Environment="SENTRY_RELEASE=vX.Y.Z"`; restored byte-exactly on rollback.                                                       |
| `/etc/systemd/system/kipclip.service.d/runtime.conf` | kipclip      | ExecStart override, written only when the release runtime kind changes (first Hono release, or a base-unit-aware legacy pin); removed/restored byte-exactly by the cutover rollback. |
| `/etc/caddy/Caddyfile`                               | root         | Bootstrap-managed.                                                                                                                                                                   |

## Failure modes

| Failure                                               | Symptom                                                                                                                                                              | Recovery                                                                                                                                                                                                                                                                                                                                                                                |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Build fails in release dir                            | `journalctl -u kipclip-release.service` shows error; `current` unchanged.                                                                                            | Push a fix tag, or pin to previous tag.                                                                                                                                                                                                                                                                                                                                                 |
| Health check fails after restart                      | `journalctl -u kipclip-release.service` shows the failure; the tick exits 1 after restoring the previous release and drop-ins.                                       | Automatic rollback runs first (symlink + drop-ins restored, systemd reloaded, old release restarted and re-verified). If the rollback also failed: `journalctl -u kipclip -n 50`, then pin the previous tag while fixing.                                                                                                                                                               |
| Pin tag doesn't exist                                 | `update.sh` exits 1 loudly; `current` unchanged.                                                                                                                     | Fix or remove the pin file.                                                                                                                                                                                                                                                                                                                                                             |
| GitHub unreachable                                    | `git fetch` fails; release skipped.                                                                                                                                  | Wait — next tick retries. No degraded state.                                                                                                                                                                                                                                                                                                                                            |
| Interrupted tick (SIGKILL / power loss)               | `/var/lib/kipclip/.release-txn/` exists; `current` and/or the drop-ins may be half-updated.                                                                          | Automatic on the next tick: recovery runs before the "nothing to do" fast-path, completing or restoring the transaction. If a rollback cannot be verified, the journal is kept (fail closed) until an operator resolves it.                                                                                                                                                             |
| Journal lost despite a successful sync (storage lies) | No `/var/lib/kipclip/.release-txn/`; the unit's effective ExecStart kind and/or the release.conf `SENTRY_RELEASE` may disagree with the release `current` points at. | Operator-blocking, not bounded: the next tick's no-journal consistency guard fails closed **before** the fetch/build/transaction (nothing mutated) on a unit/current kind mismatch, an undeterminable effective unit, or a stale/unreadable `SENTRY_RELEASE`. Inspect `systemctl cat kipclip` and the drop-ins, then fix the unit/drop-in pair or re-run `deploy/release/bootstrap.sh`. |
| daemon-reload / swap / drop-in write fails            | Tick exits 1 before the restart; the log names the failed step.                                                                                                      | Automatic: the previous drop-ins are restored (a failed reload is retried before giving up). If it persists: pin the previous tag, then check `systemctl status kipclip`.                                                                                                                                                                                                               |
| Rollback cannot be verified                           | The log names the kept journal; `kipclip` may be down.                                                                                                               | `journalctl -u kipclip -n 50`; restore the box or pin the previous tag. Later ticks keep retrying recovery and resume automatically once it can be verified.                                                                                                                                                                                                                            |
| Base unit unreadable on a legacy pin                  | Tick exits 1 before any mutation; nothing changed.                                                                                                                   | `systemctl cat kipclip`; restore the bootstrap-managed unit (`deploy/release/bootstrap.sh`); the next tick retries.                                                                                                                                                                                                                                                                     |

## Auto-update timers

The box also runs three weekly auto-update timers, independent of the kipclip
release flow above:

| Timer                       | When           | Updates                                               | Rollback path                                                                                      |
| --------------------------- | -------------- | ----------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `tap-update.timer`          | Sun 04:00 UTC  | TAP binary (pinned immutable base + downstream patch) | `/opt/tap/tap.prev` + `.version.prev`/`.patches.sha256.prev`/`.binary.sha256.prev` if health fails |
| `deno-update.timer`         | Sun 04:30 UTC  | Deno runtime at `/opt/deno/bin/deno` (patch only)     | `/opt/deno/bin/deno.prev` on `/api/health` failure                                                 |
| `unattended-upgrades.timer` | Daily (Debian) | Debian security packages                              | `apt-get install <pkg>=<oldver>`                                                                   |

> **TAP builds are pinned since v0.24.38.** `tap-update.sh` no longer tracks
> `origin/main`. It builds an immutable documented base sha
> (`41278964ec8e3253e70d4e919dfb8e34211c543d`) plus the kipclip-owned downstream
> patches in `deploy/tap/patches/`, refuses branch refs, fails loudly when a
> patch stops applying cleanly, and records `.version` (source sha) +
> `.patches.sha256` + `.binary.sha256` for the running binary — rollback
> restores all three. Full runbook, rollback and post-deploy measurements:
> **`deploy/tap/README.md`**.

`deno-update.timer` only auto-applies **patch** releases (e.g.
`v2.8.0 → v2.8.1`). Cross-minor and cross-major jumps refuse to run without a
pin file. Minor bumps can carry behavior changes (e.g. the `v2.7 → v2.8`
`setTimeout` return-type and test-sanitizer-default shifts), so they're treated
as controlled, plan-driven rollouts: bump locally, validate
`deno task quality && deno task test`, then pin the box and trigger the service
manually.

Both kipclip-managed timers (`tap-update`, `deno-update`) honour pin files for
operator override:

- TAP pin: `echo <commit-sha> | sudo tee /etc/tap/tap-version` — commit shas
  ONLY; branch refs / `origin/*` are refused.
- Deno pin: `echo v2.8.0 | sudo tee /etc/kipclip/deno-version` (required for any
  minor or major bump; clear the file once the box is stable on the new line to
  resume patch-tick auto-updates)

Trigger manually (e.g. to upgrade ahead of schedule):

```bash
sudo systemctl start tap-update.service
sudo systemctl start deno-update.service
journalctl -u tap-update.service -u deno-update.service -n 30 --no-pager
```

Disable temporarily (e.g. during a freeze):

```bash
sudo systemctl disable --now tap-update.timer deno-update.timer
```

Logs go to the journal (`journalctl -u tap-update.service -f`,
`-u deno-update.service -f`). On failure, both scripts auto-rollback before
exiting non-zero — re-running after the rollback succeeds is safe.

## Weekly reporting semantics (read `ExecMainStatus`, not `Result`)

`Result=success/failed` collides exit codes: drift-alert exits 1 (drift) and 3
(PDS errors) on purpose, and the unit row then says `Result=failed` — which is
exactly the signal you want, not a crash. The weekly housekeeping report MUST
read `ExecMainStatus` and interpret it, never report `Result=success` as "no
drift":

| ExecMainStatus (drift-alert) | Meaning                                                                   |
| ---------------------------- | ------------------------------------------------------------------------- |
| 0                            | clean run                                                                 |
| 1                            | recoverable drift detected                                                |
| 2                            | audit failed (e.g. DB unavailable, or TAP quarantine delete not verified) |
| 3                            | classified PDS errors present (nothing auto-repaired)                     |

Run the canonical read-only report on the box:

```bash
ssh kipclip "sudo bash /var/lib/kipclip/source/deploy/release/box-report.sh"
```

It emits per-unit `exec_main_status` + `result` + `last_run` (with a
`drift_kind` interpretation for drift-alert), monotonic timer freshness (seconds
until next `kipclip-release.timer` tick from the MONOTONIC clock, immune to
wall-clock skew), journal oldest/newest timestamps + disk usage + retention
config, and release provenance (app release, TAP source/binary/patch SHAs,
pins). Reporting changes to journald limits to hide log growth is forbidden —
fix the source of the log volume.

## Third-party advisories

When `deno audit` (run by `deno task quality` locally and in CI) flags a
transitive vulnerability, the fastest path is:

```bash
deno task audit:fix       # upgrades affected packages to nearest patched version
                          # that still satisfies the version constraints
deno task quality         # confirm clean
deno task test            # confirm no regressions
```

If `audit:fix` can't resolve it (the patched version is outside the declared
constraint, or there's no patched release yet), surface the entry in
`deno outdated --latest`, decide whether to bump the direct dependency, and fall
back to manual `deno.lock` surgery only as a last resort.

## CHANGELOG hygiene

Format: [Keep a Changelog](https://keepachangelog.com).

- New entries land under `## [Unreleased]` as merges land in `main`.
- At release time, rename to `## [vX.Y.Z] - YYYY-MM-DD` and add a fresh
  `## [Unreleased]` section above.
- Reference-link footer (`[vX.Y.Z]: ...compare links`) is appended at the bottom
  of `CHANGELOG.md`.
