#!/usr/bin/env bash
# Pull-based Deno runtime update for kipclip's Hetzner box.
#
# kipclip runs `/opt/deno/bin/deno serve`, so the runtime version is
# bound to the systemd unit's ExecStart. Upstream Deno ships frequently;
# we want security + perf fixes without manual intervention.
#
# Polled by deno-update.timer weekly. Each tick:
#   1. Acquire the install lock.
#   2. Resolve desired version. Pin file overrides "release-latest".
#   3. If desired matches /opt/deno/bin/deno --version, exit 0.
#   4. Refuse cross-major jumps unless pin file is set (defense against
#      Deno 2 -> Deno 3 surprises that need ack).
#   5. Download zip + sha256, verify, unzip to /opt/deno/bin/deno.new.
#   6. Save current as /opt/deno/bin/deno.prev for rollback.
#   7. Atomic rename, restart kipclip.
#   8. Health check /api/health. Rollback on failure.
#
# Env knobs:
#   DENO_UPDATE_PIN_FILE  default /etc/kipclip/deno-version
#   DENO_UPDATE_ARCH      default aarch64-unknown-linux-gnu
#
# Required tools on PATH: curl, unzip, sha256sum, systemctl, install,
# flock.
set -euo pipefail

PIN_FILE="${DENO_UPDATE_PIN_FILE:-/etc/kipclip/deno-version}"
ARCH="${DENO_UPDATE_ARCH:-aarch64-unknown-linux-gnu}"

DENO_DIR="/opt/deno/bin"
DENO_BIN="${DENO_DIR}/deno"
DENO_NEW="${DENO_DIR}/deno.new"
DENO_PREV="${DENO_DIR}/deno.prev"
LOCK_FILE="/var/lib/kipclip/.deno-update-lock"

LATEST_URL="https://dl.deno.land/release-latest.txt"
ZIP_URL_BASE="https://github.com/denoland/deno/releases/download"

HEALTH_URL="http://127.0.0.1:8000/api/health"

log() { echo "==> $*"; }
sublog() { echo "    $*"; }
err() { echo "ERROR: $*" >&2; }

require_tool() {
  if ! command -v "$1" >/dev/null 2>&1; then
    err "required tool not found on PATH: $1"
    exit 1
  fi
}

# Major version compare. Returns 0 if same major, 1 if different.
same_major() {
  local a="${1#v}" b="${2#v}"
  [[ "${a%%.*}" == "${b%%.*}" ]]
}

main() {
  require_tool curl
  require_tool unzip
  require_tool sha256sum
  require_tool systemctl
  require_tool install
  require_tool flock

  exec 9>"$LOCK_FILE"
  if ! flock -n 9; then
    exit 0
  fi

  CURRENT_VERSION=""
  if [[ -x "$DENO_BIN" ]]; then
    # `deno --version` first line: `deno 2.7.14 (stable, release, ...)`
    CURRENT_VERSION="v$("$DENO_BIN" --version 2>/dev/null | head -1 | awk '{print $2}')"
  fi
  [[ -n "$CURRENT_VERSION" ]] || {
    err "could not read current deno version"
    exit 1
  }

  PIN=""
  if [[ -s "$PIN_FILE" ]]; then
    PIN="$(tr -d '[:space:]' < "$PIN_FILE")"
  fi

  if [[ -n "$PIN" ]]; then
    DESIRED="$PIN"
    log "Pin file present: $DESIRED"
  else
    DESIRED="$(curl -fsSL --max-time 10 "$LATEST_URL" | tr -d '[:space:]')"
    [[ -n "$DESIRED" ]] || {
      err "could not fetch latest deno version from $LATEST_URL"
      exit 1
    }
  fi

  if [[ "$CURRENT_VERSION" == "$DESIRED" ]]; then
    sublog "Already on $DESIRED; nothing to do"
    exit 0
  fi

  log "Update available: $CURRENT_VERSION -> $DESIRED"

  # Major-version safety. Pin file (operator ack) bypasses the gate.
  if [[ -z "$PIN" ]] && ! same_major "$CURRENT_VERSION" "$DESIRED"; then
    err "refusing major-version jump $CURRENT_VERSION -> $DESIRED without pin file"
    err "to allow: echo '$DESIRED' | sudo tee $PIN_FILE"
    exit 1
  fi

  ZIP_URL="${ZIP_URL_BASE}/${DESIRED}/deno-${ARCH}.zip"
  SHA_URL="${ZIP_URL}.sha256sum"

  TMP_DIR="$(mktemp -d)"
  trap 'rm -rf "$TMP_DIR"' EXIT

  log "Downloading $ZIP_URL"
  curl -fsSL --max-time 120 -o "$TMP_DIR/deno.zip" "$ZIP_URL"
  curl -fsSL --max-time 30 -o "$TMP_DIR/deno.zip.sha256" "$SHA_URL"

  log "Verifying sha256"
  (cd "$TMP_DIR" && sha256sum -c deno.zip.sha256) >/dev/null

  log "Unpacking"
  unzip -q -o "$TMP_DIR/deno.zip" -d "$TMP_DIR"
  [[ -x "$TMP_DIR/deno" ]] || {
    err "zip did not contain executable deno binary"
    exit 1
  }

  # Sanity check: the new binary actually runs and reports the version
  # we expected. Catches arch mismatch / corrupted zip / Deno publishing
  # mismatched assets.
  ACTUAL="v$("$TMP_DIR/deno" --version 2>/dev/null | head -1 | awk '{print $2}')"
  if [[ "$ACTUAL" != "$DESIRED" ]]; then
    err "new binary reports $ACTUAL, expected $DESIRED"
    exit 1
  fi

  install -m 0755 "$TMP_DIR/deno" "$DENO_NEW"

  if [[ -x "$DENO_BIN" ]]; then
    cp -p "$DENO_BIN" "$DENO_PREV"
  fi

  log "Atomic swap: $DENO_BIN -> $DESIRED"
  mv "$DENO_NEW" "$DENO_BIN"

  log "Restarting kipclip"
  systemctl restart kipclip

  log "Health-checking $HEALTH_URL"
  HEALTH_OK=0
  for attempt in 1 2 3 4 5 6 7 8; do
    sleep 1
    if curl -fsS --max-time 3 "$HEALTH_URL" >/dev/null 2>&1; then
      sublog "✅ health OK on attempt $attempt"
      HEALTH_OK=1
      break
    fi
    sublog "attempt $attempt/8: not yet"
  done

  if [[ "$HEALTH_OK" != "1" ]]; then
    err "kipclip failed health check on Deno $DESIRED"
    if [[ -x "$DENO_PREV" ]]; then
      err "rolling back to $CURRENT_VERSION"
      mv "$DENO_PREV" "$DENO_BIN"
      systemctl restart kipclip
      sleep 2
      if curl -fsS --max-time 3 "$HEALTH_URL" >/dev/null 2>&1; then
        err "rollback restored kipclip successfully"
      else
        err "rollback ALSO failed health check — manual recovery required"
      fi
    else
      err "no previous binary to roll back to; manual recovery required"
    fi
    err "check: journalctl -u kipclip -n 50"
    exit 1
  fi

  log "✅ Deno updated to $DESIRED"
}

main "$@"
