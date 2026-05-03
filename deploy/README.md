# kipclip box ops runbook

This directory holds the deploy artefacts for the staging Hetzner CAX21 box that
hosts `staging.kipclip.com` during phases 0–2 of the AppView mirror migration
(see `docs/plans/2026-05-02-001-feat-appview-mirror-phases-0-2-plan.md`).

## Quick reference

```bash
# Deploy from operator's machine
./deploy/deploy.sh                             # syncs + builds + restarts

# On the box
sudo systemctl status kipclip                  # app health
sudo systemctl status tap                      # TAP firehose subscriber
sudo systemctl restart kipclip                 # restart app
sudo journalctl -u kipclip -f                  # follow app logs
sudo journalctl -u tap -f                      # follow TAP logs

# Track owner DID for sync (after auth on staging)
curl -X POST http://127.0.0.1:8000/api/sync/track \
  -H "Content-Type: application/json" \
  -H "Cookie: sid=<owner-session-cookie>" \
  -d '{"did":"did:plc:..."}'

# Inspect mirror state
sqlite3 /var/lib/kipclip/db.sqlite '.tables'
sqlite3 /var/lib/kipclip/db.sqlite 'SELECT COUNT(*) FROM bookmarks WHERE did = ?'

# Validate mirror against PDS
deno run -A /var/lib/kipclip/app/scripts/mirror-diff.ts did:plc:...

# Restore from restic snapshot
restic snapshots
restic restore <id> --target /tmp/restore
sudo systemctl stop kipclip
sudo cp /tmp/restore/.../db.sqlite /var/lib/kipclip/db.sqlite
sudo systemctl start kipclip
```

## Provisioning (U1)

1. **Create CAX21** (4 vCPU ARM, 8GB RAM, 80GB SSD) — Falkenstein or Helsinki, Debian 12 base image.
2. **Hostname:** `kipclip-box-01`. Apply unattended-upgrades:
   ```bash
   sudo apt update && sudo apt install -y unattended-upgrades
   ```
3. **System users** (no login):
   ```bash
   sudo useradd --system --shell /usr/sbin/nologin --home-dir /var/lib/kipclip kipclip
   sudo useradd --system --shell /usr/sbin/nologin --home-dir /var/lib/tap tap
   sudo install -d -o kipclip -g kipclip /var/lib/kipclip
   sudo install -d -o tap -g tap /var/lib/tap
   sudo install -d /var/log/kipclip /var/log/tap /etc/kipclip /etc/tap
   ```
4. **Deno:**
   ```bash
   curl -fsSL https://deno.land/install.sh | sudo DENO_INSTALL=/opt/deno sh
   ```
5. **Caddy:** Debian repo
   (https://caddyserver.com/docs/install#debian-ubuntu-raspbian).
6. **Tools:**
   ```bash
   sudo apt install -y restic git jq sqlite3 fail2ban
   ```
7. **SSH hardening:** keys-only, fail2ban, no root login.

## DNS + Caddy (U2)

1. Add A record `staging.kipclip.com → <box-ip>`, TTL 300.
2. Drop `deploy/Caddyfile` to `/etc/caddy/Caddyfile`.
3. `sudo systemctl reload caddy`. Caddy auto-issues Let's Encrypt cert on first
   request. Verify: `curl -I https://staging.kipclip.com`.

## App deploy (U3)

1. **Env file** at `/etc/kipclip/env` (no quotes, one per line):
   ```
   COOKIE_SECRET=<same as Deno Deploy>
   BASE_URL=https://staging.kipclip.com
   TURSO_DATABASE_URL=<shared with prod during phases 0-2>
   TURSO_AUTH_TOKEN=<shared with prod>
   SENTRY_DSN=<same DSN>
   MIRROR_MODE=off
   ```
   Locked down:
   `sudo chown root:kipclip /etc/kipclip/env && sudo chmod 640 /etc/kipclip/env`.
2. **Initial clone** (operator machine):
   ```bash
   ssh box 'sudo install -d -o kipclip -g kipclip /var/lib/kipclip/app'
   ./deploy/deploy.sh
   ```
3. **Enable services:**
   ```bash
   sudo systemctl enable --now kipclip
   ```
4. **Verify:** owner logs in at `https://staging.kipclip.com`, browses, logs
   out. Sentry events tagged `deployment=box`.

## Backups (U4 — deferred to phase 3)

> **Status:** Skipped during phases 0–2. Hetzner Cloud's daily VPS snapshot is enabled
> on the box and covers infra recovery. Mirror tables, TAP cursor, sessions on Turso, and
> app code are all regeneratable. Restic becomes required at phase 3 when sessions move
> to local libSQL — land it BEFORE the DNS cutover.

When phase 3 lands, complete the following:

1. Provision Hetzner Storage Box. Note SFTP endpoint + user.
2. Initialise repo:
   ```bash
   sudo install -d -o root -g root -m 700 /etc/kipclip
   sudo tee /etc/kipclip/restic.env <<EOF
   ```

RESTIC_REPOSITORY=sftp:userNNN@boxNNN.your-storagebox.de:/kipclip
RESTIC_PASSWORD=<generated-key> EOF sudo chmod 600 /etc/kipclip/restic.env sudo
-E env $(cat /etc/kipclip/restic.env) restic init

````
3. Cron: `sudo ln -s /var/lib/kipclip/app/deploy/restic-backup.sh /etc/cron.daily/kipclip-backup`.
4. **Restore drill:** verify the Quick Reference restore steps end-to-end at
least once before phase 1 dogfood.

## TAP install (U10)

Pinned version + binary source TBD during install spike. Final paths:

- Binary at `/opt/tap/tap`.
- Config at `/etc/tap/config.yaml` (see `tap.config.example` for skeleton).
- State dir `/var/lib/tap/`.
- Service `deploy/systemd/tap.service` enabled via `systemctl enable --now tap`.
- Control bind `127.0.0.1:7000`. Verify: `journalctl -u tap` shows relay
connection; no DIDs tracked at install time.

## Dogfood validation (U13–U15)

1. Track owner DID:
```bash
curl -X POST http://127.0.0.1:8000/api/sync/track \
  -H "Content-Type: application/json" \
  -H "Cookie: sid=<owner-session>" \
  -d '{"did":"did:plc:..."}'
````

2. Watch backfill: `journalctl -u tap -u kipclip -f`.
3. When `tracked_dids.backfill_complete_at` is set, run:
   ```bash
   deno run -A scripts/mirror-diff.ts did:plc:...
   ```
4. Flip read mode: edit `/etc/kipclip/env` → `MIRROR_MODE=read`,
   `sudo systemctl restart kipclip`.
5. ~1 week dogfood. Daily diff + Sentry watch. Log observations below.

### Dogfood log

| Date   | Notes                  |
| ------ | ---------------------- |
| _stub_ | _filled in during U15_ |

## Rollback paths

- **Phase 1 (mirror infra dormant):** `MIRROR_MODE=off` in `/etc/kipclip/env`,
  `sudo systemctl restart kipclip`. No data movement needed.
- **Phase 2 (mirror reads enabled):** same as phase 1 — flipping `MIRROR_MODE`
  back to `off` reverts to PDS reads. Owner returns to prod (Deno Deploy) for
  daily use.
- Phase 3+ rollbacks: deferred to follow-up plans.
