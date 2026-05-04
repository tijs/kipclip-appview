#!/usr/bin/env bash
# Nightly restic backup of kipclip durable state to Hetzner Storage Box.
#
# Backs up:
#   - Turso dump (sessions, user_settings, import_jobs — the only stores
#     not regenerable from PDS).
#   - Local libSQL mirror.db hot snapshot (defense in depth — mirror is
#     regenerable via TAP getRepo, but a snapshot makes recovery fast).
#   - TAP cursor / state dir.
#
# Cron / systemd timer: nightly at 04:00 UTC.
#
# Required env (set in /etc/kipclip/restic.env, sourced below):
#   RESTIC_REPOSITORY    — sftp://userNNN@boxNNN.your-storagebox.de:23/kipclip
#   RESTIC_PASSWORD      — repo encryption key
#   TURSO_DB_NAME        — name of the Turso DB (used by `turso db shell`)
#
# Required tools on PATH: restic, turso (authenticated), sqlite3.
#
# Retention: 14 daily, 4 weekly, 6 monthly (per plan 004 R4).
set -euo pipefail

ENV_FILE="/etc/kipclip/restic.env"
LOCAL_DB_FILE="/var/lib/kipclip/mirror.db"
LOCAL_SNAP_FILE="/tmp/kipclip-mirror-snap.sqlite"
TURSO_DUMP_FILE="/tmp/kipclip-turso-dump.sql"
TAP_DIR="/var/lib/tap"

if [[ -f "$ENV_FILE" ]]; then
  # shellcheck disable=SC1090
  source "$ENV_FILE"
else
  echo "ERROR: $ENV_FILE missing" >&2
  exit 1
fi

if [[ -z "${TURSO_DB_NAME:-}" ]]; then
  echo "ERROR: TURSO_DB_NAME not set in $ENV_FILE" >&2
  exit 1
fi

cleanup() {
  rm -f "$LOCAL_SNAP_FILE" "$TURSO_DUMP_FILE"
}
trap cleanup EXIT

# Sentry-style failure logging: any non-zero exit propagates to systemd,
# which can fire a journald alert / notification email. The wrapper script
# in deploy/restic-backup-wrap.sh (separate file) is recommended for Sentry
# integration; this script keeps responsibilities small and exits cleanly.

PATHS=()

# 1. Turso dump — the irreplaceable durable state.
echo "==> Dumping Turso database '$TURSO_DB_NAME'..."
turso db shell "$TURSO_DB_NAME" ".dump" > "$TURSO_DUMP_FILE"
if [[ ! -s "$TURSO_DUMP_FILE" ]]; then
  echo "ERROR: Turso dump produced an empty file; aborting" >&2
  exit 1
fi
PATHS+=("$TURSO_DUMP_FILE")
echo "    Turso dump: $(wc -l < "$TURSO_DUMP_FILE") SQL lines"

# 2. Local mirror.db hot snapshot — defense in depth.
if [[ -f "$LOCAL_DB_FILE" ]]; then
  echo "==> Snapshotting local mirror.db..."
  # Atomic hot snapshot — does not lock the live DB.
  sqlite3 "$LOCAL_DB_FILE" ".backup $LOCAL_SNAP_FILE"
  PATHS+=("$LOCAL_SNAP_FILE")
fi

# 3. TAP state.
if [[ -d "$TAP_DIR" ]]; then
  PATHS+=("$TAP_DIR")
fi

if [[ ${#PATHS[@]} -eq 0 ]]; then
  echo "Nothing to back up. Exiting cleanly."
  exit 0
fi

echo "==> Running restic backup..."
restic backup "${PATHS[@]}"

echo "==> Pruning old snapshots..."
restic forget --keep-daily 14 --keep-weekly 4 --keep-monthly 6 --prune

echo "==> Verifying repo integrity..."
restic check --read-data-subset=5%

echo "✅ Backup complete."
