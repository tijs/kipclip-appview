# kipclip box ops runbook

Deploy artefacts for the production Hetzner box that serves `kipclip.com`. The
box runs the Fresh server, a local libSQL mirror of every tracked user's
bookmark data, restic backups to B2, Caddy as the TLS edge, and TAP (an indigo
atproto sync utility) which firehoses events into a webhook on the box.

For the release flow itself (pull-based tags, pin override, rollback), see
`deploy/release/README.md`.

## Quick reference

```bash
# On the box
sudo systemctl status kipclip                  # app health
sudo systemctl status tap                      # TAP firehose subscriber
sudo systemctl restart kipclip                 # restart app
sudo journalctl -u kipclip -f                  # follow app logs
sudo journalctl -u tap -f                      # follow TAP logs
sudo journalctl --disk-usage                   # journal size (capped at 1G)

# Release flow (see deploy/release/README.md for full runbook)
sudo systemctl list-timers kipclip-release.timer tap-update.timer deno-update.timer

# Track a DID for sync (after auth)
curl -X POST http://127.0.0.1:8000/api/sync/track \
  -H "Content-Type: application/json" \
  -H "Cookie: sid=<session-cookie>" \
  -d '{"did":"did:plc:..."}'

# Inspect mirror state
sqlite3 /var/lib/kipclip/mirror.db '.tables'
sqlite3 /var/lib/kipclip/mirror.db 'SELECT COUNT(*) FROM bookmarks WHERE did = ?'

# Validate mirror against PDS
deno run -A /var/lib/kipclip/current/scripts/mirror-diff.ts did:plc:...

# Restore from restic snapshot
sudo -E env $(cat /etc/kipclip/restic.env) restic snapshots
sudo -E env $(cat /etc/kipclip/restic.env) restic restore <id> --target /tmp/restore
sudo systemctl stop kipclip
sudo cp /tmp/restore/var/lib/kipclip/mirror.db /var/lib/kipclip/mirror.db
sudo systemctl start kipclip
```

## Bootstrapping a fresh box

Run on a clean Debian 13 host. Total time ~5 minutes excluding manual env-file
edits.

1. **Create CAX21** (4 vCPU ARM, 8GB RAM, 80GB SSD) — Falkenstein or Helsinki.
   Hostname: `kipclip-box-01`.
2. **OS prereqs** (Caddy, restic, git, jq, sqlite3, fail2ban,
   unattended-upgrades, golang for TAP, build tools, curl, unzip):
   ```bash
   sudo deploy/release/install-prereqs.sh
   ```
3. **System users** (no login shells):
   ```bash
   sudo useradd --system --shell /usr/sbin/nologin --home-dir /var/lib/kipclip kipclip
   sudo useradd --system --shell /usr/sbin/nologin --home-dir /var/lib/tap tap
   sudo install -d -o kipclip -g kipclip /var/lib/kipclip
   sudo install -d -o tap -g tap /var/lib/tap
   sudo install -d /var/log/kipclip /var/log/tap /etc/kipclip /etc/tap
   ```
4. **Deno runtime**:
   ```bash
   sudo deploy/release/install-deno.sh
   ```
   `deno-update.timer` keeps it current weekly after this.
5. **Env files** (out-of-band — never committed). Schema is documented in the
   example files:
   ```bash
   sudo cp deploy/kipclip.env.example /etc/kipclip/env       # fill in
   sudo cp deploy/restic.env.example /etc/kipclip/restic.env # fill in
   # /etc/tap/env: see deploy/tap.config.example for keys
   sudo chown root:kipclip /etc/kipclip/env /etc/kipclip/restic.env
   sudo chmod 0640 /etc/kipclip/env
   sudo chmod 0600 /etc/kipclip/restic.env
   sudo chown root:tap /etc/tap/env && sudo chmod 0640 /etc/tap/env
   ```
6. **DNS**: A record `kipclip.com → <box-ip>`, TTL 300. Caddy auto-issues Let's
   Encrypt cert on first request.
7. **Bootstrap**:
   ```bash
   sudo deploy/release/bootstrap.sh
   ```
   Installs systemd units, sudoers, Caddyfile, journald cap, and enables every
   timer. Triggers the first release synchronously so failure is loud.
8. **TAP install** (one-off):
   ```bash
   sudo install -d -o tap -g tap /var/lib/tap/build
   sudo -u tap git clone https://github.com/bluesky-social/indigo.git \
     /var/lib/tap/build/indigo
   sudo systemctl start tap-update.service   # builds + installs /opt/tap/tap
   sudo systemctl enable --now tap
   ```

## Backups

`restic-backup.timer` runs nightly at 04:00 UTC, snapshotting
`/var/lib/kipclip/mirror.db` to Backblaze B2 via the S3 API.

- Repo URL, password, B2 credentials live in `/etc/kipclip/restic.env` (mode
  0600, root-owned). See `deploy/restic.env.example` for the schema.
- Retention is enforced by the `restic forget --prune` policy in
  `deploy/restic-backup.sh`.
- Restore drill: see Quick reference above. Run end-to-end at least once a
  quarter to verify the password + repo are still good.

## Auto-update timers

| Timer                   | When            | Action                                                                    |
| ----------------------- | --------------- | ------------------------------------------------------------------------- |
| `kipclip-release.timer` | Every 60s       | Pulls latest `v*` tag merged into `main`, builds, atomic-swaps, restarts. |
| `tap-update.timer`      | Sun 04:00 UTC   | Rebuilds TAP from indigo `main` on the box, restarts.                     |
| `deno-update.timer`     | Sun 04:30 UTC   | Pulls latest stable Deno from `dl.deno.land`, sha-verifies, restarts.     |
| `restic-backup.timer`   | Daily 04:00 UTC | Snapshots `mirror.db` to B2.                                              |
| `unattended-upgrades`   | Daily (Debian)  | Debian security packages only.                                            |

All update timers have rollback paths on health-check failure. Pin overrides
documented in `deploy/release/README.md`.

## Logging

Everything goes to systemd journal — there are no separate log files to rotate.
Journal is capped at 1G via `/etc/systemd/journald.conf.d/kipclip.conf`
(`SystemMaxUse=1G`, `SystemKeepFree=2G`, `MaxFileSec=1week`).

```bash
sudo journalctl -u kipclip -f          # app logs
sudo journalctl -u tap -f              # firehose subscriber
sudo journalctl -u kipclip-release -f  # release flow
sudo journalctl --disk-usage           # current journal size
```

## Rollback paths

- **App**: pin a previous tag via `/etc/kipclip/release-pin`. Next 60s tick
  swaps. See `deploy/release/README.md`.
- **TAP**: `/opt/tap/tap.prev` is restored automatically on health failure.
  Manual rollback:
  `sudo mv /opt/tap/tap.prev /opt/tap/tap && sudo systemctl restart tap`.
- **Deno**: `/opt/deno/bin/deno.prev` same shape. Auto-rollback on `/api/health`
  failure.
- **Mirror DB**: restore from restic snapshot (Quick reference). Mirror is
  regeneratable from PDS via `mirror-diff.ts` re-backfill if backups are
  unavailable, but the restic path is faster.
- **OS pkg upgrade gone bad**: `apt-get install <pkg>=<previous-version>`, then
  add the version to `/etc/apt/apt.conf.d/50unattended-upgrades`
  Package-Blacklist while you investigate.

## File ownership reference

| Path                         | Owner        | Notes                                                        |
| ---------------------------- | ------------ | ------------------------------------------------------------ |
| `/var/lib/kipclip/`          | kipclip      | App working tree, releases, mirror.db                        |
| `/var/lib/kipclip/mirror.db` | kipclip      | Local libSQL primary (survives release swaps)                |
| `/var/lib/tap/`              | tap          | TAP state, indigo build dir, go cache                        |
| `/opt/tap/tap`               | root         | TAP binary (root-owned; `tap-update.sh` installs as root)    |
| `/opt/deno/bin/deno`         | root         | Deno runtime (same)                                          |
| `/etc/kipclip/env`           | root:kipclip | App env (0640)                                               |
| `/etc/kipclip/restic.env`    | root:root    | Restic env (0600)                                            |
| `/etc/tap/env`               | root:tap     | TAP env (0640)                                               |
| `/etc/caddy/Caddyfile`       | root         | Bootstrap-managed                                            |
| `/etc/sudoers.d/kipclip`     | root         | NOPASSWD scope: `systemctl restart kipclip`, `daemon-reload` |
