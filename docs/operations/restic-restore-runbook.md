# Restic restore runbook

How to restore kipclip durable state from the Hetzner Storage Box. Use this
runbook for periodic drills (required before phase 3 DNS flip per plan 004 R5)
and for genuine disaster recovery.

## What's backed up

Nightly via `deploy/systemd/restic-backup.timer` (04:00 UTC):

1. **Turso dump** — `tmp/kipclip-turso-dump.sql` Sessions, user_settings,
   import_jobs, import_chunks, plus mirror tables for safety. Produced via
   `turso db shell <db> .dump`.
2. **Local mirror snapshot** — `tmp/kipclip-mirror-snap.sqlite` SQLite
   hot-snapshot of `/var/lib/kipclip/mirror.db`. Defense in depth — the mirror
   is regenerable from PDS via TAP `getRepo`, but the snapshot makes recovery
   measurably faster.
3. **TAP state** — `var/lib/tap/` Cursor + relay state. Resumable from the
   relay's current position if missing, but restoring avoids the catch-up
   window.

Retention: 14 daily, 4 weekly, 6 monthly.

## Prerequisites

- `restic` on PATH, authenticated to the Storage Box repo.
- `/etc/kipclip/restic.env` populated with `RESTIC_REPOSITORY` and
  `RESTIC_PASSWORD`.
- For DR (not drill): `turso` CLI on PATH and authenticated, sufficient
  privileges to create / write to a Turso DB.

## Drill procedure (verify only)

Run quarterly or before any production gate that depends on backup viability
(e.g., phase 3 DNS flip).

```bash
# 1. List recent snapshots — confirm timer is running and snapshots are recent.
restic snapshots --compact

# 2. Restore the latest snapshot to a scratch directory (does NOT touch live DBs).
sudo /var/lib/kipclip/app/deploy/restic-restore.sh

# 3. Inspect the Turso dump.
less /tmp/kipclip-restore/tmp/kipclip-turso-dump.sql
# Confirm: CREATE TABLE statements for iron_session_storage, user_settings,
# import_jobs, bookmarks, etc. Some INSERT rows.

# 4. Sanity-check the local mirror snapshot.
sqlite3 /tmp/kipclip-restore/tmp/kipclip-mirror-snap.sqlite \
  "SELECT 'bookmarks', COUNT(*) FROM bookmarks
   UNION ALL SELECT 'tags', COUNT(*) FROM tags
   UNION ALL SELECT 'tracked_dids', COUNT(*) FROM tracked_dids;"

# 5. Compare against the live mirror as a smoke test.
sqlite3 /var/lib/kipclip/mirror.db \
  "SELECT 'bookmarks', COUNT(*) FROM bookmarks
   UNION ALL SELECT 'tags', COUNT(*) FROM tags;"

# 6. Tear down the scratch dir.
rm -rf /tmp/kipclip-restore

# 7. Record the drill in the operator log: date, snapshot ID, row counts,
#    time-to-restore.
```

**Pass criteria.** All three: snapshot recent (≤24h), Turso dump has CREATE
TABLE + INSERT lines, local mirror row counts within ±1 day's writes of the live
DB.

## Disaster recovery (full restore)

Use when local mirror.db is corrupted, the box is replaced, or Turso is restored
from a fresh DB.

```bash
# 1. Stop the app so no writes happen during restore.
sudo systemctl stop kipclip
sudo systemctl stop tap  # also stops dual-write source

# 2. Restore from latest snapshot.
sudo /var/lib/kipclip/app/deploy/restic-restore.sh

# 3. Restore Turso (only when Turso itself is wiped or being rebuilt):
turso db shell <new-or-empty-db-name> < /tmp/kipclip-restore/tmp/kipclip-turso-dump.sql

# 4. Restore local mirror.db.
sudo mv /var/lib/kipclip/mirror.db /var/lib/kipclip/mirror.db.bak.$(date +%s)
sudo cp /tmp/kipclip-restore/tmp/kipclip-mirror-snap.sqlite /var/lib/kipclip/mirror.db
sudo chown kipclip:kipclip /var/lib/kipclip/mirror.db
sudo chmod 0640 /var/lib/kipclip/mirror.db

# 5. Restore TAP cursor.
sudo rsync -a /tmp/kipclip-restore/var/lib/tap/ /var/lib/tap/
sudo chown -R tap:tap /var/lib/tap

# 6. Restart services.
sudo systemctl start tap
sudo systemctl start kipclip

# 7. Verify.
journalctl -u kipclip -n 50 -f
journalctl -u tap -n 50 -f
# Confirm: app boots, mirror migrations idempotent, TAP resumes from cursor.

# 8. Watch Sentry for "mirror dual-write" / "mirror read fallback" signals
#    over the first hour. None expected once both DBs are caught up.
```

## Recovery time objectives

Captured during the most recent drill. Update after each drill.

| Step                      | Target       | Last measured |
| ------------------------- | ------------ | ------------- |
| Restore from Storage Box  | < 5 min      | —             |
| Turso dump apply          | < 10 min     | —             |
| Local mirror copy + chown | < 1 min      | —             |
| TAP resume to live edge   | < 5 min      | —             |
| **Total RTO**             | **< 30 min** | —             |

## What CAN'T be recovered from backup

- Brief writes between the last backup (≤24h ago) and the disaster.
  Bookmarks/tags/preferences are recoverable from PDS via TAP `getRepo`.
  Sessions and Instapaper credentials in this window are lost — users re-login,
  re-enter Instapaper auth.
- TAP events delivered between backup and disaster. The relay re-delivers if the
  cursor regresses; idempotent upserts make this safe.

## Failure modes

- **`turso db shell` returns empty dump.** Re-auth the CLI; check
  `TURSO_DB_NAME` is correct in `/etc/kipclip/restic.env`. The script aborts if
  the dump is empty, so this fails loud rather than silently storing a useless
  snapshot.
- **`restic check` fails.** Repo corruption. Investigate before next backup
  runs; do NOT prune until resolved (forget operations on a corrupt repo can
  lose data).
- **Storage Box quota exceeded.** Retention policy may need tightening, or large
  mirror.db needs trimming. The systemd unit's failure surfaces via
  `systemctl status restic-backup`.
