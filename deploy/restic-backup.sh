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
#   RESTIC_REPOSITORY    — repo URL (e.g. s3:s3.fr-par.scw.cloud/kipclip-restic)
#   RESTIC_PASSWORD      — repo encryption key
#   TURSO_DATABASE_URL   — used by the Deno dumper (already in app env)
#   TURSO_AUTH_TOKEN     — used by the Deno dumper (already in app env)
#   AWS_ACCESS_KEY_ID    — Scaleway IAM key (when using S3 backend)
#   AWS_SECRET_ACCESS_KEY — Scaleway IAM secret
#
# Required tools on PATH: restic, deno, sqlite3.
#
# Retention: 14 daily, 4 weekly, 6 monthly (per plan 004 R4).
set -euo pipefail

ENV_FILE="/etc/kipclip/restic.env"
APP_ENV_FILE="/etc/kipclip/env"
APP_DIR="/var/lib/kipclip/app"
DENO_BIN="${DENO_BIN:-/opt/deno/bin/deno}"
LOCAL_DB_FILE="/var/lib/kipclip/mirror.db"
LOCAL_SNAP_FILE="/tmp/kipclip-mirror-snap.sqlite"
TURSO_DUMP_FILE="/tmp/kipclip-turso-dump.sql"
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

# Pull TURSO_DATABASE_URL + TURSO_AUTH_TOKEN from the app env (single source
# of truth) so we don't duplicate creds in restic.env.
if [[ -f "$APP_ENV_FILE" ]]; then
  # shellcheck disable=SC1090
  set -a
  source "$APP_ENV_FILE"
  set +a
fi

if [[ -z "${TURSO_DATABASE_URL:-}" || -z "${TURSO_AUTH_TOKEN:-}" ]]; then
  echo "ERROR: TURSO_DATABASE_URL / TURSO_AUTH_TOKEN missing (expected in $APP_ENV_FILE)" >&2
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
# Uses the in-repo Deno dumper (scripts/dump-turso-tables.ts) over the
# libSQL HTTP client, so no turso CLI install / interactive auth needed.
echo "==> Dumping Turso tables via Deno dumper..."
"$DENO_BIN" run -A "$APP_DIR/scripts/dump-turso-tables.ts" > "$TURSO_DUMP_FILE"
if [[ ! -s "$TURSO_DUMP_FILE" ]]; then
  echo "ERROR: Turso dump produced an empty file; aborting" >&2
  exit 1
fi
# Sanity check: the dumper auto-discovers tables and emits one CREATE
# TABLE per table. A partial dump (libSQL flake mid-run, missing schema)
# would still be non-empty but underweight; reject anything below the
# baseline so we never store a silently-incomplete snapshot.
MIN_TABLES="${MIN_TABLES:-8}" # 5 mirror + 4 turso-only - 1 fudge
TABLE_COUNT=$(grep -c '^CREATE TABLE' "$TURSO_DUMP_FILE" || true)
if (( TABLE_COUNT < MIN_TABLES )); then
  echo "ERROR: Turso dump has $TABLE_COUNT CREATE TABLE statements; expected >= $MIN_TABLES" >&2
  exit 1
fi
PATHS+=("$TURSO_DUMP_FILE")
echo "    Turso dump: $(wc -l < "$TURSO_DUMP_FILE") SQL lines, $TABLE_COUNT tables"

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

# Verify integrity BEFORE pruning. forget --prune on a corrupt repo can
# delete healthy snapshots — so we gate pruning on a clean check.
echo "==> Verifying repo integrity..."
restic check --read-data-subset=5%

echo "==> Pruning old snapshots..."
restic forget --keep-daily 14 --keep-weekly 4 --keep-monthly 6 --prune

echo "✅ Backup complete."
