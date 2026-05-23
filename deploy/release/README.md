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

Verify:

```bash
curl https://kipclip.com/api/version
# { "version": "vX.Y.Z" }
# (sha + builtAt are operator-only since v0.12.0; ssh and read
# /var/lib/kipclip/current/static/manifest.json for the full set)

ssh kipclip-box "journalctl -u kipclip-release.service -n 30 --no-pager"
```

The frontend footer shows the running tag and links to the GitHub release page.

## Pin override (incident, manual rollback)

To stop the box from auto-rolling forward:

```bash
ssh kipclip-box
echo "vX.Y.Z" | sudo tee /etc/kipclip/release-pin
```

The next timer tick reads the pin file and stays on (or rolls back to) `vX.Y.Z`.
The pin survives reboots.

To unpin:

```bash
ssh kipclip-box "sudo rm /etc/kipclip/release-pin"
```

The next tick picks the latest semver tag merged into `origin/main`.

## Rollback

Two options:

- **Pin to the previous tag.** Recommended — no force-push, no history rewrite.
  `echo vX.Y.Z-1 | sudo tee /etc/kipclip/release-pin`.
- **Move the `release` candidate by re-tagging.** Force-push only as a last
  resort, and only if the bad tag has not been advertised.

## Bootstrap-redo (config changes)

When `deploy/Caddyfile`, `deploy/systemd/*.service`,
`deploy/release/*.{service,timer,rules}`, or `deploy/release/kipclip.sudoers`
need to update (e.g. the `wss://kipclip.com` connect-src entry that the
`/api/live` WebSocket needs in CSP):

```bash
ssh kipclip-box "cd /var/lib/kipclip/source && sudo git pull && \
  sudo bash deploy/release/bootstrap.sh"
```

This is the only path that writes to `/etc/caddy/`, `/etc/systemd/`, or
`/etc/sudoers.d/`. The 60s auto-release flow never touches them — the structural
fix that prevents the phase 4 Caddyfile-clobber bug recurring.

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

| Path                                                 | Owner        | Purpose                                                                                     |
| ---------------------------------------------------- | ------------ | ------------------------------------------------------------------------------------------- |
| `/var/lib/kipclip/source/`                           | kipclip      | Pull-source git clone. `update.sh` runs `git fetch` here every 60s.                         |
| `/var/lib/kipclip/releases/<tag>/`                   | kipclip      | Materialised release trees. Last 5 retained, older GC'd.                                    |
| `/var/lib/kipclip/current`                           | kipclip      | Symlink to the running release dir. `kipclip.service` resolves through this.                |
| `/var/lib/kipclip/mirror.db`                         | kipclip      | Local libSQL mirror. Outside release dirs — survives swaps.                                 |
| `/etc/kipclip/env`                                   | root:kipclip | App env file (`0640`). Bootstrap-managed (never written by `update.sh`).                    |
| `/etc/kipclip/restic.env`                            | root         | Restic backup credentials (`0600`). Bootstrap-managed.                                      |
| `/etc/kipclip/release-pin`                           | root:kipclip | Optional pin override (a single tag, `0644`). Empty/missing = use latest.                   |
| `/etc/tap/env`                                       | root:tap     | TAP env file (`0640`). Bootstrap-managed.                                                   |
| `/etc/systemd/system/kipclip.service.d/release.conf` | root         | Drop-in written by `update.sh` at swap time, holding `Environment="SENTRY_RELEASE=vX.Y.Z"`. |
| `/etc/caddy/Caddyfile`                               | root         | Bootstrap-managed.                                                                          |

## Failure modes

| Failure                          | Symptom                                                                     | Recovery                                                                                     |
| -------------------------------- | --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Build fails in release dir       | `journalctl -u kipclip-release.service` shows error; `current` unchanged.   | Push a fix tag, or pin to previous tag.                                                      |
| Health check fails after restart | Same journal entry; `current` is on the new tag but the process won't bind. | `journalctl -u kipclip -n 50`. Likely env or migration issue. Pin previous tag while fixing. |
| Pin tag doesn't exist            | `update.sh` exits 1 loudly; `current` unchanged.                            | Fix or remove the pin file.                                                                  |
| GitHub unreachable               | `git fetch` fails; release skipped.                                         | Wait — next tick retries. No degraded state.                                                 |

## Auto-update timers

The box also runs three weekly auto-update timers, independent of the kipclip
release flow above:

| Timer                       | When           | Updates                                           | Rollback path                                      |
| --------------------------- | -------------- | ------------------------------------------------- | -------------------------------------------------- |
| `tap-update.timer`          | Sun 04:00 UTC  | TAP binary (rebuild from indigo `main`)           | `/opt/tap/tap.prev` if health fails                |
| `deno-update.timer`         | Sun 04:30 UTC  | Deno runtime at `/opt/deno/bin/deno` (patch only) | `/opt/deno/bin/deno.prev` on `/api/health` failure |
| `unattended-upgrades.timer` | Daily (Debian) | Debian security packages                          | `apt-get install <pkg>=<oldver>`                   |

`deno-update.timer` only auto-applies **patch** releases (e.g.
`v2.8.0 → v2.8.1`). Cross-minor and cross-major jumps refuse to run without a
pin file. Minor bumps can carry behavior changes (e.g. the `v2.7 → v2.8`
`setTimeout` return-type and test-sanitizer-default shifts), so they're treated
as controlled, plan-driven rollouts: bump locally, validate
`deno task quality && deno task test`, then pin the box and trigger the service
manually.

Both kipclip-managed timers (`tap-update`, `deno-update`) honour pin files for
operator override:

- TAP pin: `echo <commit-sha> | sudo tee /etc/tap/tap-version`
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
