#!/usr/bin/env bash
# Restore the most recent restic snapshot to a scratch directory.
#
# Use this script for:
#   - Periodic restore drills (verify backups are usable).
#   - Disaster recovery (restore primary SQLite + TAP state on a fresh box).
#
# Restores into $RESTORE_DIR (default /tmp/kipclip-restore) WITHOUT touching
# the live DB. The operator is responsible for moving files into place
# (cp primary-snap.sqlite /var/lib/kipclip/kipclip.db).
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
  set -a
  source "$ENV_FILE"
  set +a
else
  echo "ERROR: $ENV_FILE missing" >&2
  exit 1
fi

# Restore dir contains plaintext OAuth access/refresh tokens and DPoP private
# keys. Lock it down to the invoking user only.
umask 077
mkdir -p "$RESTORE_DIR"
chmod 0700 "$RESTORE_DIR"

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

  Drill (verify only — DO NOT replace live DB):
    1. Sanity-check the primary SQLite snapshot:
         sqlite3 $RESTORE_DIR/tmp/kipclip-primary-snap.sqlite \\
           "SELECT 'bookmarks', COUNT(*) FROM bookmarks
            UNION ALL SELECT 'tags', COUNT(*) FROM tags
            UNION ALL SELECT 'tracked_dids', COUNT(*) FROM tracked_dids;"
    2. Compare row counts to the live DB as a smoke test.
    3. Tear down the scratch dir (contains OAuth tokens):
         shred -u $RESTORE_DIR/tmp/kipclip-primary-snap.sqlite 2>/dev/null || true
         rm -rf $RESTORE_DIR

  Disaster recovery (replace live DB):
    1. Stop the app:
         systemctl stop kipclip
    2. Restore primary SQLite:
         mv /var/lib/kipclip/kipclip.db /var/lib/kipclip/kipclip.db.bak.\$(date +%s)
         cp $RESTORE_DIR/tmp/kipclip-primary-snap.sqlite /var/lib/kipclip/kipclip.db
         chown kipclip:kipclip /var/lib/kipclip/kipclip.db
         chmod 0640 /var/lib/kipclip/kipclip.db
    3. Restore TAP cursor:
         rsync -a $RESTORE_DIR/var/lib/tap/ /var/lib/tap/
         chown -R tap:tap /var/lib/tap
    4. Restart services:
         systemctl start kipclip
         systemctl start tap
EOF
