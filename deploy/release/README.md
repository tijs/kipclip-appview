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
need to update:

```bash
ssh kipclip-box "cd /var/lib/kipclip/source && sudo git pull && \
  sudo bash deploy/release/bootstrap.sh"
```

This is the only path that writes to `/etc/caddy/`, `/etc/systemd/`, or
`/etc/sudoers.d/`. The 60s auto-release flow never touches them — the structural
fix that prevents the phase 4 Caddyfile-clobber bug recurring.

## TAP webhook shared secret

`worker/webhook.ts` enforces an Authorization-header check when
`TAP_WEBHOOK_SECRET` is set on kipclip. Two header shapes accepted:

- `Basic admin:<secret>` — what TAP currently sends (it reuses
  `TAP_ADMIN_PASSWORD` for outbound webhook auth via
  `cmd/tap/webhook_client.go`).
- `Bearer <secret>` — forward-compat for a future TAP that decouples outbound
  webhook auth from admin auth.

Defense-in-depth behind Caddy `respond @hook 403` — Caddy is the primary
barrier, the bearer/basic check catches config drift.

Rollout (must be coordinated; both sides need the same secret in the same
maintenance window — TAP currently uses one secret for both inbound API auth and
outbound webhook auth, so changing it rotates both at once):

1. Generate a 32+-char secret: `openssl rand -hex 32`
2. On the box, set `TAP_ADMIN_PASSWORD=<secret>` in `/etc/tap/env`. This doubles
   as the outbound webhook auth (TAP sends it as Basic `admin:<password>`).
3. On the box, set `TAP_WEBHOOK_SECRET=<secret>` in `/etc/kipclip/env` to the
   same value.
4. Restart both services: `sudo systemctl restart tap kipclip` (TAP must restart
   first so the next webhook delivery carries the new password; if kipclip
   restarts first and TAP hasn't picked up the new secret, every webhook 401s
   for the gap).
5. Verify in journalctl: `journalctl -u kipclip -n 20 | grep webhook` should NOT
   show "TAP_WEBHOOK_SECRET not set" warning. TAP's outbound webhook delivery
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

## CHANGELOG hygiene

Format: [Keep a Changelog](https://keepachangelog.com).

- New entries land under `## [Unreleased]` as merges land in `main`.
- At release time, rename to `## [vX.Y.Z] - YYYY-MM-DD` and add a fresh
  `## [Unreleased]` section above.
- Reference-link footer (`[vX.Y.Z]: ...compare links`) is appended at the bottom
  of `CHANGELOG.md`.
