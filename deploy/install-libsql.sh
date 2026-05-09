#!/usr/bin/env bash
# One-shot setup for local libSQL on the kipclip box.
#
# Creates /var/lib/kipclip/ owned by the kipclip user, ensures sqlite3 is
# available for backup snapshots, and seeds the empty kipclip.db file. The
# app process opens this file directly via the @libsql/client native driver
# when DATABASE_URL=file:/var/lib/kipclip/kipclip.db is set in its environment.
#
# Run as root once on a fresh box. Idempotent.
#
# After this script completes:
#   1. Add DATABASE_URL=file:/var/lib/kipclip/kipclip.db to the app's env file
#   2. Restart the app — migrations will create all tables on first boot
set -euo pipefail

KIPCLIP_USER="${KIPCLIP_USER:-kipclip}"
DATA_DIR="/var/lib/kipclip"
DB_FILE="${DATA_DIR}/kipclip.db"

if [[ $EUID -ne 0 ]]; then
  echo "ERROR: must run as root" >&2
  exit 1
fi

# sqlite3 CLI is needed for restic-backup.sh's hot snapshot path.
if ! command -v sqlite3 >/dev/null 2>&1; then
  echo "Installing sqlite3..."
  apt-get update -qq
  apt-get install -y -qq sqlite3
fi

# Verify the kipclip user exists; phases 0-2 setup creates it.
if ! id "$KIPCLIP_USER" >/dev/null 2>&1; then
  echo "ERROR: user '$KIPCLIP_USER' does not exist; run phases 0-2 setup first" >&2
  exit 1
fi

# Create data dir + empty DB file with correct ownership.
mkdir -p "$DATA_DIR"
chown "$KIPCLIP_USER:$KIPCLIP_USER" "$DATA_DIR"
chmod 0750 "$DATA_DIR"

if [[ ! -f "$DB_FILE" ]]; then
  # libSQL/sqlite creates the file on first open; seed an empty one with
  # correct ownership so the app process can open it.
  sudo -u "$KIPCLIP_USER" sqlite3 "$DB_FILE" "PRAGMA journal_mode=WAL;"
  echo "✅ Created $DB_FILE (WAL mode)"
else
  echo "ℹ️  $DB_FILE already exists; leaving it untouched"
fi

# Sanity check: app process can read+write.
if sudo -u "$KIPCLIP_USER" sqlite3 "$DB_FILE" "SELECT 1;" >/dev/null 2>&1; then
  echo "✅ $DB_FILE is readable by $KIPCLIP_USER"
else
  echo "ERROR: $DB_FILE is not readable by $KIPCLIP_USER" >&2
  exit 1
fi

cat <<EOF

Local SQLite installed.

Next steps:
  1. Edit /etc/kipclip/env and add:
       DATABASE_URL=file:${DB_FILE}
  2. Restart the app:
       systemctl restart kipclip
  3. Tail the logs to confirm migrations run:
       journalctl -u kipclip -f

EOF
