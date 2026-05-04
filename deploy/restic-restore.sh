#!/usr/bin/env bash
# Restore the most recent restic snapshot to a scratch directory.
#
# Use this script for:
#   - Periodic restore drills (verify backups are usable; required before
#     phase 3 DNS flip per plan 004 R5).
#   - Disaster recovery (rebuild Turso + local mirror.db on a fresh box).
#
# Restores into $RESTORE_DIR (default /tmp/kipclip-restore) WITHOUT touching
# the live DBs. The operator is responsible for moving files into place
# (turso db shell <db> < dump.sql; mv mirror-snap.sqlite /var/lib/kipclip/mirror.db).
#
# Required env (in /etc/kipclip/restic.env):
#   RESTIC_REPOSITORY
#   RESTIC_PASSWORD
#
# Optional:
#   SNAPSHOT_ID   — restic snapshot ID; defaults to "latest"
#   RESTORE_DIR   — target directory; defaults to /tmp/kipclip-restore
set -euo pipefail

ENV_FILE="/etc/kipclip/restic.env"
SNAPSHOT_ID="${SNAPSHOT_ID:-latest}"
RESTORE_DIR="${RESTORE_DIR:-/tmp/kipclip-restore}"

if [[ -f "$ENV_FILE" ]]; then
  # shellcheck disable=SC1090
  source "$ENV_FILE"
else
  echo "ERROR: $ENV_FILE missing" >&2
  exit 1
fi

mkdir -p "$RESTORE_DIR"

echo "==> Listing snapshots..."
restic snapshots --compact

echo "==> Restoring snapshot $SNAPSHOT_ID to $RESTORE_DIR..."
restic restore "$SNAPSHOT_ID" --target "$RESTORE_DIR"

echo
echo "✅ Restore complete. Contents of $RESTORE_DIR:"
find "$RESTORE_DIR" -type f -exec ls -lh {} \;

echo
cat <<EOF
Next steps (drill or DR):

  Drill (verify only — DO NOT replace live DBs):
    1. Read the Turso dump:
         less $RESTORE_DIR/tmp/kipclip-turso-dump.sql
       Confirm it contains expected CREATE TABLE + INSERT lines.
    2. Sanity-check the local mirror snapshot:
         sqlite3 $RESTORE_DIR/tmp/kipclip-mirror-snap.sqlite \\
           "SELECT COUNT(*) FROM bookmarks;"
    3. Compare row counts to the live mirror as a smoke test.

  Disaster recovery (replace live DBs):
    1. Stop the kipclip app:
         systemctl stop kipclip
    2. Restore Turso (creates a NEW db; or overwrite an empty one):
         turso db shell <new-db-name> < $RESTORE_DIR/tmp/kipclip-turso-dump.sql
    3. Restore local mirror.db:
         mv $RESTORE_DIR/tmp/kipclip-mirror-snap.sqlite /var/lib/kipclip/mirror.db
         chown kipclip:kipclip /var/lib/kipclip/mirror.db
    4. Restore TAP cursor:
         rsync -a $RESTORE_DIR/var/lib/tap/ /var/lib/tap/
    5. Update env (if Turso URL changed) and restart:
         systemctl start kipclip
EOF
