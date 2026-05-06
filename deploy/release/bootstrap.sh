#!/usr/bin/env bash
# Bootstrap the kipclip box for pull-based releases.
#
# Run this:
#   1. Once when adding a new box.
#   2. Whenever Caddyfile or systemd unit shapes need to change in
#      production (this script is the only path that writes to /etc/caddy/
#      or /etc/systemd/system/ — the auto-release flow never touches them).
#
# Idempotent: re-running on a healthy box updates config files in place
# and re-runs the first release. Existing release dirs are not removed.
#
# Required tools: git, systemctl, caddy, ln.
set -euo pipefail

REPO_URL="${KIPCLIP_RELEASE_REPO_URL:-https://github.com/tijs/kipclip-appview.git}"
BRANCH="${KIPCLIP_RELEASE_BRANCH:-main}"

KIPCLIP_USER="kipclip"
KIPCLIP_GROUP="kipclip"
KIPCLIP_ROOT="/var/lib/kipclip"
SOURCE_DIR="${KIPCLIP_ROOT}/source"
RELEASES_DIR="${KIPCLIP_ROOT}/releases"
CURRENT_LINK="${KIPCLIP_ROOT}/current"
LEGACY_APP_DIR="${KIPCLIP_ROOT}/app"

# bootstrap.sh is shipped inside the source tree the script clones, so on
# a fresh box it lives wherever the operator copied it from. After the
# initial clone, subsequent re-runs read from $SOURCE_DIR.
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

log() { echo "==> $*"; }
sublog() { echo "    $*"; }
err() { echo "ERROR: $*" >&2; }

if [[ $EUID -ne 0 ]]; then
  err "must run as root (sudo $0)"
  exit 1
fi

for tool in git systemctl caddy ln; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    err "required tool not found on PATH: $tool"
    exit 1
  fi
done

# Ensure kipclip user exists. id -u returns non-zero on missing user.
if ! id -u "$KIPCLIP_USER" >/dev/null 2>&1; then
  err "user $KIPCLIP_USER does not exist; create it before running bootstrap"
  exit 1
fi

# Step 1: ensure $SOURCE_DIR exists as a clone of the repo.
log "Setting up $SOURCE_DIR (kipclip's pull-source clone)"
mkdir -p "$KIPCLIP_ROOT" "$RELEASES_DIR"
chown "${KIPCLIP_USER}:${KIPCLIP_GROUP}" "$KIPCLIP_ROOT" "$RELEASES_DIR"

if [[ -d "${SOURCE_DIR}/.git" ]]; then
  sublog "source clone already present; fetching latest"
  sudo -u "$KIPCLIP_USER" git -C "$SOURCE_DIR" fetch --tags --prune origin "$BRANCH"
else
  sublog "cloning $REPO_URL"
  sudo -u "$KIPCLIP_USER" git clone --branch "$BRANCH" "$REPO_URL" "$SOURCE_DIR"
fi

# Step 2: migrate legacy /var/lib/kipclip/app directory if present.
if [[ -d "$LEGACY_APP_DIR" && ! -L "$LEGACY_APP_DIR" ]]; then
  log "Migrating legacy $LEGACY_APP_DIR to $RELEASES_DIR/legacy"
  if [[ -d "${RELEASES_DIR}/legacy" ]]; then
    sublog "/releases/legacy already exists; removing legacy app dir"
    rm -rf "$LEGACY_APP_DIR"
  else
    mv "$LEGACY_APP_DIR" "${RELEASES_DIR}/legacy"
    chown -R "${KIPCLIP_USER}:${KIPCLIP_GROUP}" "${RELEASES_DIR}/legacy"
    ln -sfn "${RELEASES_DIR}/legacy" "$CURRENT_LINK"
    chown -h "${KIPCLIP_USER}:${KIPCLIP_GROUP}" "$CURRENT_LINK"
    sublog "✅ /var/lib/kipclip/current -> /releases/legacy (will be replaced on first release)"
  fi
fi

# If legacy migration didn't fire and there's no current symlink yet,
# create a placeholder pointing at $SOURCE_DIR so systemctl daemon-reload
# below doesn't fail validating the kipclip.service WorkingDirectory.
# update.sh on first run replaces this with a real release dir.
if [[ ! -L "$CURRENT_LINK" && ! -e "$CURRENT_LINK" ]]; then
  log "No current symlink yet; placeholder -> $SOURCE_DIR"
  ln -sfn "$SOURCE_DIR" "$CURRENT_LINK"
  chown -h "${KIPCLIP_USER}:${KIPCLIP_GROUP}" "$CURRENT_LINK"
fi

# Step 3: install / refresh systemd units. Source files live under the
# pull-source clone so this picks up whatever shape the latest main has.
#
# Pre-create the SENTRY_RELEASE drop-in directory so the
# kipclip-release.service unit's ReadWritePaths resolves at namespace
# setup time. Without this, systemd fails the unit with status
# 226/NAMESPACE before update.sh ever runs.
log "Installing systemd units"
mkdir -p /etc/systemd/system/kipclip.service.d
# kipclip user writes /etc/systemd/system/kipclip.service.d/release.conf
# at every release swap (carries SENTRY_RELEASE for the next restart).
# Drop-in dir is owned by kipclip so the write doesn't need sudo.
chown "${KIPCLIP_USER}:${KIPCLIP_GROUP}" /etc/systemd/system/kipclip.service.d
chmod 0755 /etc/systemd/system/kipclip.service.d
install -m 0644 "${SOURCE_DIR}/deploy/systemd/kipclip.service" \
  /etc/systemd/system/kipclip.service
install -m 0644 "${SOURCE_DIR}/deploy/systemd/restic-backup.service" \
  /etc/systemd/system/restic-backup.service
install -m 0644 "${SOURCE_DIR}/deploy/release/kipclip-release.service" \
  /etc/systemd/system/kipclip-release.service
install -m 0644 "${SOURCE_DIR}/deploy/release/kipclip-release.timer" \
  /etc/systemd/system/kipclip-release.timer

# Step 4: install sudoers drop-in granting the kipclip user NOPASSWD on
# the two systemctl commands update.sh needs (`restart kipclip` and
# `daemon-reload`). Validate with visudo before moving into place — a
# bad sudoers file can lock the operator out of the box.
log "Installing sudoers drop-in for kipclip user systemctl access"
TMP_SUDOERS="$(mktemp)"
trap 'rm -f "$TMP_SUDOERS"' EXIT
install -m 0440 "${SOURCE_DIR}/deploy/release/kipclip.sudoers" "$TMP_SUDOERS"
visudo -c -f "$TMP_SUDOERS" >/dev/null
install -m 0440 "$TMP_SUDOERS" /etc/sudoers.d/kipclip
rm -f "$TMP_SUDOERS"
trap - EXIT

systemctl daemon-reload
systemctl enable --now kipclip-release.timer

# Step 5: install / refresh Caddyfile.
log "Installing Caddyfile"
install -m 0644 "${SOURCE_DIR}/deploy/Caddyfile" /etc/caddy/Caddyfile
sublog "validating"
caddy validate --config /etc/caddy/Caddyfile
systemctl reload caddy

# Step 6: trigger first release synchronously so the operator sees it
# succeed (or fail loud) instead of waiting for the next 60s timer tick.
log "Triggering first release run"
systemctl start --wait kipclip-release.service || {
  err "first release run failed; check journalctl -u kipclip-release.service"
  exit 1
}

log "✅ Bootstrap complete."
sublog "current release: $(readlink -f "$CURRENT_LINK")"
sublog "next pull check: ~60s"
