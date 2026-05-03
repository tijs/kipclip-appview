#!/usr/bin/env bash
# Nightly restic backup of kipclip libSQL DB + TAP state to Hetzner Storage Box.
# Cron entry: 0 4 * * * /var/lib/kipclip/app/deploy/restic-backup.sh
#
# Required env (set in /etc/kipclip/restic.env, sourced below):
#   RESTIC_REPOSITORY  — sftp://userNNN@boxNNN.your-storagebox.de:23/kipclip
#   RESTIC_PASSWORD    — repo encryption key
set -euo pipefail

ENV_FILE="/etc/kipclip/restic.env"
DB_FILE="/var/lib/kipclip/db.sqlite"
SNAP_FILE="/tmp/kipclip-snap.sqlite"
TAP_DIR="/var/lib/tap"

if [[ -f "$ENV_FILE" ]]; then
  # shellcheck disable=SC1090
  source "$ENV_FILE"
else
  echo "ERROR: $ENV_FILE missing" >&2
  exit 1
fi

cleanup() {
  rm -f "$SNAP_FILE"
}
trap cleanup EXIT

PATHS=()

if [[ -f "$DB_FILE" ]]; then
  # Atomic hot snapshot — does not lock the live DB.
  sqlite3 "$DB_FILE" ".backup $SNAP_FILE"
  PATHS+=("$SNAP_FILE")
fi

if [[ -d "$TAP_DIR" ]]; then
  PATHS+=("$TAP_DIR")
fi

if [[ ${#PATHS[@]} -eq 0 ]]; then
  echo "Nothing to back up yet (no DB, no TAP state). Exiting cleanly."
  exit 0
fi

restic backup "${PATHS[@]}"
restic forget --keep-daily 7 --keep-weekly 4 --keep-monthly 12 --prune
