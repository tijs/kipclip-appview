# Restic restore runbook

How to restore kipclip durable state from the Hetzner Storage Box. Use this
runbook for periodic drills and genuine disaster recovery.

## What's backed up

Nightly via `deploy/systemd/restic-backup.timer` (04:00 UTC):

1. **Primary SQLite snapshot** — `tmp/kipclip-primary-snap.sqlite` Hot-snapshot
   of `/var/lib/kipclip/kipclip.db` (all tables: OAuth sessions, user_settings,
   import_jobs, and all mirror tables). Produced by `sqlite3 .backup` which
   holds a shared lock for the snapshot duration without blocking concurrent
   writers.
2. **TAP state** — `var/lib/tap/` Cursor + relay state. Resumable from the
   relay's current position if missing, but restoring avoids the catch-up
   window.

Retention: 14 daily, 4 weekly, 6 monthly.

## Prerequisites

- `restic` on PATH, authenticated to the Storage Box repo.
- `/etc/kipclip/restic.env` populated with `RESTIC_REPOSITORY`,
  `RESTIC_PASSWORD`, and (for S3 backends) `AWS_ACCESS_KEY_ID` /
  `AWS_SECRET_ACCESS_KEY`.

## Drill procedure (verify only)

Run quarterly or before any production gate that depends on backup viability.

```bash
# 1. List recent snapshots — confirm timer is running and snapshots are recent.
restic snapshots --compact

# 2. Restore the latest snapshot to a scratch directory (does NOT touch live DB).
sudo /var/lib/kipclip/app/deploy/restic-restore.sh

# 3. Sanity-check the primary SQLite snapshot.
sqlite3 /tmp/kipclip-restore/tmp/kipclip-primary-snap.sqlite \
  "SELECT 'bookmarks', COUNT(*) FROM bookmarks
   UNION ALL SELECT 'tags', COUNT(*) FROM tags
   UNION ALL SELECT 'tracked_dids', COUNT(*) FROM tracked_dids
   UNION ALL SELECT 'sessions', COUNT(*) FROM sessions;"

# 4. Compare against the live DB as a smoke test.
sqlite3 /var/lib/kipclip/kipclip.db \
  "SELECT 'bookmarks', COUNT(*) FROM bookmarks
   UNION ALL SELECT 'tags', COUNT(*) FROM tags
   UNION ALL SELECT 'sessions', COUNT(*) FROM sessions;"

# 5. Tear down the scratch dir. The snapshot contains plaintext OAuth tokens
#    and DPoP private keys; shred before unlinking.
shred -u /tmp/kipclip-restore/tmp/kipclip-primary-snap.sqlite 2>/dev/null || true
rm -rf /tmp/kipclip-restore

# 6. Record the drill: date, snapshot ID, row counts, time-to-restore.
```

**Pass criteria.** Snapshot recent (≤24h), snapshot opens cleanly, row counts
within ±1 day's writes of the live DB.

## Disaster recovery (full restore)

Use when the primary SQLite is corrupted or the box is replaced.

```bash
# 1. Stop the app so no writes happen during restore.
sudo systemctl stop kipclip
sudo systemctl stop tap

# 2. Restore from latest snapshot.
sudo /var/lib/kipclip/app/deploy/restic-restore.sh

# 3. Restore primary SQLite.
sudo mv /var/lib/kipclip/kipclip.db /var/lib/kipclip/kipclip.db.bak.$(date +%s)
sudo cp /tmp/kipclip-restore/tmp/kipclip-primary-snap.sqlite \
        /var/lib/kipclip/kipclip.db
sudo chown kipclip:kipclip /var/lib/kipclip/kipclip.db
sudo chmod 0640 /var/lib/kipclip/kipclip.db

# 4. Restore TAP cursor.
sudo rsync -a /tmp/kipclip-restore/var/lib/tap/ /var/lib/tap/
sudo chown -R tap:tap /var/lib/tap

# 5. Restart services.
sudo systemctl start tap
sudo systemctl start kipclip

# 6. Verify.
journalctl -u kipclip -n 50 -f
journalctl -u tap -n 50 -f
# Confirm: app boots, migrations idempotent, TAP resumes from cursor.
```

## Recovery time objectives

Captured during the most recent drill. Update after each drill.

| Step                     | Target       | Last measured |
| ------------------------ | ------------ | ------------- |
| Restore from Storage Box | < 5 min      | —             |
| SQLite copy + chown      | < 1 min      | —             |
| TAP resume to live edge  | < 5 min      | —             |
| **Total RTO**            | **< 15 min** | —             |

## What CAN'T be recovered from backup

- Brief writes between the last backup (≤24h ago) and the disaster.
  Bookmarks/tags/preferences are recoverable from PDS via TAP `getRepo`.
  Sessions and Instapaper credentials in this window are lost — users re-login,
  re-enter Instapaper auth.
- TAP events delivered between backup and disaster. The relay re-delivers if the
  cursor regresses; idempotent upserts make this safe.

## Failure modes

- **SQLite snapshot is empty.** Confirm `DATABASE_URL` resolves to a readable
  file, `sqlite3` is on PATH, and the app process has not locked the WAL in an
  unusual way. The backup script aborts on an empty snapshot.
- **`restic check` fails.** Repo corruption. Investigate before next backup
  runs; do NOT prune until resolved (forget operations on a corrupt repo can
  lose data).
- **Storage Box quota exceeded.** Retention policy may need tightening, or the
  primary SQLite has grown unusually large. The systemd unit's failure surfaces
  via `systemctl status restic-backup`.
