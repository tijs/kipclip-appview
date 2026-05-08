#!/usr/bin/env bash
# Pull-based TAP update for kipclip's Hetzner box.
#
# TAP (`bluesky-social/indigo` `cmd/tap`) is the firehose subscriber that
# feeds /api/sync/hook on the box. Upstream has no release cadence — it
# tracks `main`. This script keeps our box ~weekly fresh while leaving an
# operator-controlled override and a rollback path on health failure.
#
# Polled by tap-update.timer weekly. Each tick:
#   1. Acquire the build lock (non-blocking — skip if a prior tick is
#      still building, e.g. on a slow disk).
#   2. Resolve the desired indigo ref. Pin file overrides "origin/main".
#   3. Fetch + reset the existing indigo clone in /var/lib/tap/build.
#   4. If the resolved commit matches /opt/tap/.version, exit 0.
#   5. Build cmd/tap into /opt/tap/tap.new.
#   6. Save /opt/tap/tap as /opt/tap/tap.prev (rollback target).
#   7. Atomic-rename tap.new -> tap. Restart tap.service.
#   8. Health-check 127.0.0.1:2480 (any HTTP response — TAP returns 401
#      without auth which is a sufficient liveness signal). On failure,
#      restore tap.prev and restart.
#
# Env knobs (rare, mostly for staging dry-runs):
#   TAP_UPDATE_REPO_URL  override indigo remote (default upstream)
#   TAP_UPDATE_BRANCH    default "main"
#   TAP_UPDATE_PIN_FILE  default /etc/tap/tap-version  (commit sha or branch)
#
# Required tools on PATH: git, go, systemctl, curl, flock, install.
set -euo pipefail

REPO_URL="${TAP_UPDATE_REPO_URL:-https://github.com/bluesky-social/indigo.git}"
BRANCH="${TAP_UPDATE_BRANCH:-main}"
PIN_FILE="${TAP_UPDATE_PIN_FILE:-/etc/tap/tap-version}"

BUILD_DIR="/var/lib/tap/build/indigo"
TAP_BIN_DIR="/opt/tap"
TAP_BIN="${TAP_BIN_DIR}/tap"
TAP_NEW="${TAP_BIN_DIR}/tap.new"
TAP_PREV="${TAP_BIN_DIR}/tap.prev"
TAP_VERSION_FILE="${TAP_BIN_DIR}/.version"
LOCK_FILE="/var/lib/tap/.tap-update-lock"

# tap user owns the build dir + go cache. Only the install step needs root.
TAP_USER="tap"
TAP_GROUP="tap"

HEALTH_URL="http://127.0.0.1:2480/"

log() { echo "==> $*"; }
sublog() { echo "    $*"; }
err() { echo "ERROR: $*" >&2; }

require_tool() {
  if ! command -v "$1" >/dev/null 2>&1; then
    err "required tool not found on PATH: $1"
    exit 1
  fi
}

# A liveness check that accepts any HTTP response. TAP requires basic
# auth on every endpoint, so 401 is the success signal we want — it
# proves the process is up, the port is bound, and the HTTP stack is
# serving. Network errors / connection refused are failure.
health_ok() {
  local code
  code="$(curl -o /dev/null -s -w '%{http_code}' --max-time 3 "$HEALTH_URL" || echo "000")"
  [[ "$code" =~ ^[2345][0-9][0-9]$ ]]
}

main() {
  require_tool git
  require_tool go
  require_tool curl
  require_tool flock
  require_tool systemctl
  require_tool install
  [[ -d "$BUILD_DIR/.git" ]] || {
    err "indigo clone missing at $BUILD_DIR — bootstrap TAP first"
    exit 1
  }
  [[ -d "$TAP_BIN_DIR" ]] || {
    err "tap install dir missing at $TAP_BIN_DIR"
    exit 1
  }

  exec 9>"$LOCK_FILE"
  if ! flock -n 9; then
    exit 0
  fi

  # Resolve desired ref. Pin file wins.
  PIN=""
  if [[ -s "$PIN_FILE" ]]; then
    PIN="$(tr -d '[:space:]' < "$PIN_FILE")"
  fi

  log "Fetching $REPO_URL"
  sudo -u "$TAP_USER" git -C "$BUILD_DIR" fetch --prune origin "$BRANCH" >/dev/null

  if [[ -n "$PIN" ]]; then
    DESIRED_REF="$PIN"
    log "Pin file present: $PIN"
  else
    DESIRED_REF="origin/${BRANCH}"
  fi

  if ! DESIRED_SHA="$(sudo -u "$TAP_USER" git -C "$BUILD_DIR" rev-parse --verify "${DESIRED_REF}^{commit}" 2>/dev/null)"; then
    err "cannot resolve $DESIRED_REF in $BUILD_DIR"
    exit 1
  fi
  DESIRED_SHORT="${DESIRED_SHA:0:12}"

  CURRENT_SHA=""
  if [[ -s "$TAP_VERSION_FILE" ]]; then
    CURRENT_SHA="$(tr -d '[:space:]' < "$TAP_VERSION_FILE")"
  fi

  if [[ "$CURRENT_SHA" == "$DESIRED_SHA" ]]; then
    sublog "Already on ${DESIRED_SHORT}; nothing to do"
    exit 0
  fi

  log "Building TAP $DESIRED_SHORT (was: ${CURRENT_SHA:0:12})"
  sudo -u "$TAP_USER" git -C "$BUILD_DIR" checkout --quiet "$DESIRED_SHA"

  # Build as tap user so go module + build cache stay tap-owned. Output
  # to a tap-writable temp path; root moves it into /opt/tap below.
  BUILD_OUT="${BUILD_DIR}/tap-build-out"
  rm -f "$BUILD_OUT"
  sudo -u "$TAP_USER" \
    env HOME=/var/lib/tap GOCACHE=/var/lib/tap/gocache GOPATH=/var/lib/tap/go \
    go build -C "$BUILD_DIR" -o "$BUILD_OUT" ./cmd/tap

  if [[ ! -x "$BUILD_OUT" ]]; then
    err "build produced no executable at $BUILD_OUT"
    exit 1
  fi

  log "Installing $DESIRED_SHORT -> $TAP_BIN"
  install -m 0755 "$BUILD_OUT" "$TAP_NEW"
  rm -f "$BUILD_OUT"

  # Save current as prev for rollback. First-run case (no current)
  # leaves TAP_PREV absent, which the rollback path handles.
  if [[ -x "$TAP_BIN" ]]; then
    cp -p "$TAP_BIN" "$TAP_PREV"
  fi

  # Atomic rename — same filesystem.
  mv "$TAP_NEW" "$TAP_BIN"
  echo "$DESIRED_SHA" > "$TAP_VERSION_FILE"

  log "Restarting tap.service"
  systemctl restart tap

  log "Health-checking $HEALTH_URL"
  HEALTH_OK=0
  for attempt in 1 2 3 4 5; do
    sleep 2
    if health_ok; then
      sublog "✅ health OK on attempt $attempt"
      HEALTH_OK=1
      break
    fi
    sublog "attempt $attempt/5: not yet"
  done

  if [[ "$HEALTH_OK" != "1" ]]; then
    err "TAP failed health check on $DESIRED_SHORT"
    if [[ -x "$TAP_PREV" ]]; then
      err "rolling back to previous binary"
      mv "$TAP_PREV" "$TAP_BIN"
      echo "${CURRENT_SHA}" > "$TAP_VERSION_FILE"
      systemctl restart tap
      sleep 2
      if health_ok; then
        err "rollback restored TAP successfully"
      else
        err "rollback ALSO failed health check — manual recovery required"
      fi
    else
      err "no previous binary to roll back to; manual recovery required"
    fi
    err "check: journalctl -u tap -n 50"
    exit 1
  fi

  log "✅ TAP updated to $DESIRED_SHORT"
}

main "$@"
