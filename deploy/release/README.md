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
# { "version": "vX.Y.Z", "sha": "...", "builtAt": "..." }

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

When `deploy/Caddyfile`, `deploy/systemd/*.service`, or
`deploy/release/*.{service,timer,rules}` shapes need to update:

```bash
ssh kipclip-box "cd /var/lib/kipclip/source && sudo git pull && \
  sudo bash deploy/release/bootstrap.sh"
```

This is the only path that writes to `/etc/caddy/`, `/etc/systemd/`, or
`/etc/polkit-1/rules.d/`. The 60s auto-release flow never touches them — the
structural fix that prevents the phase 4 Caddyfile-clobber bug recurring.

## What lives where on the box

| Path                                                 | Owner   | Purpose                                                                                     |
| ---------------------------------------------------- | ------- | ------------------------------------------------------------------------------------------- |
| `/var/lib/kipclip/source/`                           | kipclip | Pull-source git clone. `update.sh` runs `git fetch` here every 60s.                         |
| `/var/lib/kipclip/releases/<tag>/`                   | kipclip | Materialised release trees. Last 5 retained, older GC'd.                                    |
| `/var/lib/kipclip/current`                           | kipclip | Symlink to the running release dir. `kipclip.service` resolves through this.                |
| `/var/lib/kipclip/mirror.db`                         | kipclip | Local libSQL mirror. Outside release dirs — survives swaps.                                 |
| `/etc/kipclip/env`                                   | root    | App env file. Bootstrap-managed (never written by `update.sh`).                             |
| `/etc/kipclip/restic.env`                            | root    | Restic backup credentials. Bootstrap-managed.                                               |
| `/etc/kipclip/release-pin`                           | root    | Optional pin override (a single tag). Empty/missing = use latest.                           |
| `/etc/systemd/system/kipclip.service.d/release.conf` | root    | Drop-in written by `update.sh` at swap time, holding `Environment="SENTRY_RELEASE=vX.Y.Z"`. |
| `/etc/caddy/Caddyfile`                               | root    | Bootstrap-managed.                                                                          |

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
