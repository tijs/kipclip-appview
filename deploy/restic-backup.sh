#!/usr/bin/env bash
# Nightly restic backup of kipclip durable state to Hetzner Storage Box.
#
# Backs up:
#   - Primary SQLite hot snapshot (kipclip.db — all tables: OAuth sessions,
#     user_settings, import_jobs, and all mirror tables).
#   - TAP cursor / state dir.
#
# Cron / systemd timer: nightly at 04:00 UTC.
#
# Required env (set in /etc/kipclip/restic.env, sourced below):
#   RESTIC_REPOSITORY    — repo URL (e.g. s3:s3.fr-par.scw.cloud/kipclip-restic)
#   RESTIC_PASSWORD      — repo encryption key
#   AWS_ACCESS_KEY_ID    — Scaleway IAM key (when using S3 backend)
#   AWS_SECRET_ACCESS_KEY — Scaleway IAM secret
#
# Required tools on PATH: restic, sqlite3.
#
# Retention: 14 daily, 4 weekly, 6 monthly (per plan 004 R4).
set -euo pipefail

ENV_FILE="/etc/kipclip/restic.env"
APP_ENV_FILE="/etc/kipclip/env"
DENO_BIN="${DENO_BIN:-/opt/deno/bin/deno}"
LOCAL_SNAP_FILE="/tmp/kipclip-primary-snap.sqlite"
TAP_DIR="/var/lib/tap"

if [[ -f "$ENV_FILE" ]]; then
  # shellcheck disable=SC1090
  set -a
  source "$ENV_FILE"
  set +a
else
  echo "ERROR: $ENV_FILE missing" >&2
  exit 1
fi

# Pull DATABASE_URL from the app env to derive the primary DB path.
if [[ -f "$APP_ENV_FILE" ]]; then
  # shellcheck disable=SC1090
  set -a
  source "$APP_ENV_FILE"
  set +a
fi

# Derive the filesystem path from DATABASE_URL (strip file: prefix).
DB_URL="${DATABASE_URL:-file:/var/lib/kipclip/kipclip.db}"
LOCAL_DB_FILE="${DB_URL#file:}"

if [[ ! -f "$LOCAL_DB_FILE" ]]; then
  echo "ERROR: Primary SQLite not found at $LOCAL_DB_FILE (DATABASE_URL=$DB_URL)" >&2
  exit 1
fi

cleanup() {
  rm -f "$LOCAL_SNAP_FILE"
}
trap cleanup EXIT

# Sentry-style failure logging: any non-zero exit propagates to systemd,
# which can fire a journald alert / notification email. The wrapper script
# in deploy/restic-backup-wrap.sh (separate file) is recommended for Sentry
# integration; this script keeps responsibilities small and exits cleanly.

PATHS=()

# 1. Primary SQLite hot snapshot — all durable state.
# sqlite3 .backup acquires a shared lock for the snapshot duration; writes
# are not blocked (WAL mode allows concurrent readers).
echo "==> Snapshotting primary database ($LOCAL_DB_FILE)..."
sqlite3 "$LOCAL_DB_FILE" ".backup $LOCAL_SNAP_FILE"
if [[ ! -s "$LOCAL_SNAP_FILE" ]]; then
  echo "ERROR: SQLite snapshot is empty; aborting" >&2
  exit 1
fi
PATHS+=("$LOCAL_SNAP_FILE")
echo "    Snapshot: $(du -h "$LOCAL_SNAP_FILE" | cut -f1)"

# 2. TAP state.
if [[ -d "$TAP_DIR" ]]; then
  PATHS+=("$TAP_DIR")
fi

if [[ ${#PATHS[@]} -eq 0 ]]; then
  echo "Nothing to back up. Exiting cleanly."
  exit 0
fi

echo "==> Running restic backup..."
restic backup "${PATHS[@]}"

# Verify integrity BEFORE pruning. forget --prune on a corrupt repo can
# delete healthy snapshots — so we gate pruning on a clean check.
echo "==> Verifying repo integrity..."
restic check --read-data-subset=5%

echo "==> Pruning old snapshots..."
restic forget --keep-daily 14 --keep-weekly 4 --keep-monthly 6 --prune

echo "✅ Backup complete."
