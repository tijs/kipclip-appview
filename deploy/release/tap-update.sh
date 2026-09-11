#!/usr/bin/env bash
# Pull-based TAP update for kipclip's Hetzner box.
#
# TAP (`bluesky-social/indigo` `cmd/tap`) is the firehose subscriber that
# feeds /api/sync/hook on the box. Upstream has no release cadence and no
# fixed backoff bug, so this script builds an EXPLICIT, IMMUTABLE base
# revision plus the kipclip-owned downstream patch — NEVER a silently
# moving `origin/main`.
#
# Since v0.24.38 (see deploy/tap/README.md):
#   - Default build source is the documented, immutable upstream base
#     revision TAP_DEFAULT_BASE_SHA + the patches in PATCH_DIR. The pin
#     file (/etc/tap/tap-version) may override with ANOTHER COMMIT SHA only.
#     Branch names and `origin/*` refs are refused — pinning a moving ref
#     is how the retry-storm build silently changed under us.
#   - The patch must apply cleanly on the checked-out base, or the build
#     FAILS (source drift is loud, never silently rebuilt).
#   - .version records the SOURCE base sha; .patches.sha256 records the
#     applied patches; .binary.sha256 records the installed binary sha.
#     Every tick and every rollback re-records all three. Health checks and
#     logs always name source + patch + binary sha so an operator can
#     compare what is actually running against what was reviewed.
#
# Polled by tap-update.timer weekly (Sun 04:00 UTC). Each tick:
#   1. Acquire the build lock (non-blocking — skip if a prior tick is
#      still building).
#   2. Resolve the desired ref: pin file > TAP_UPDATE_DEFAULT_REF (sha
#      required) > $TAP_DEFAULT_BASE_SHA. Refuse branch refs / origin/*.
#   3. Fetch + checkout the immutable base sha in /var/lib/tap/build.
#   4. Apply every patch in PATCH_DIR with `git apply --check` then apply.
#   5. If the resolved commit matches /opt/tap/.version AND the patch set
#      matches .patches.sha256, exit 0.
#   6. Build cmd/tap into /opt/tap/tap.new.
#   7. Save /opt/tap/tap + the sha/version files as .prev (rollback target).
#   8. Atomic-rename tap.new -> tap. Write .version/.patches.sha256/
#      .binary.sha256. Restart tap.service.
#   9. Health-check 127.0.0.1:2480. On failure — a FAILED restart counts
#      too, not just a bad health check — restore the previous binary AND
#      the previous sha/version files, restart, re-check.
#
# Env knobs (rare, mostly for staging dry-runs):
#   TAP_UPDATE_REPO_URL    override indigo remote (default upstream)
#   TAP_UPDATE_PIN_FILE    default /etc/tap/tap-version (commit sha ONLY)
#   TAP_UPDATE_DEFAULT_REF an alternate immutable commit sha (sha ONLY)
#   TAP_UPDATE_PATCH_DIR   default /var/lib/kipclip/source/deploy/tap/patches
#
# Required tools on PATH: git, go, systemctl, curl, flock, install, sha256sum.
set -euo pipefail

REPO_URL="${TAP_UPDATE_REPO_URL:-https://github.com/bluesky-social/indigo.git}"
PIN_FILE="${TAP_UPDATE_PIN_FILE:-/etc/tap/tap-version}"

# The reviewed, immutable upstream base for the kipclip downstream patch
# (verified byte-identical at patch time; see deploy/tap/patches/*.patch):
#   cmd/tap/util.go backoff() overflow fix, base = upstream main
#   41278964ec8e3253e70d4e919dfb8e34211c543d (2026-09-03).
# Upstream has no fix as of 2026-09-11; do not bump without re-reviewing
# the patch against the new base.
TAP_DEFAULT_BASE_SHA="41278964ec8e3253e70d4e919dfb8e34211c543d"

# Paths are env-overridable so staging dry-runs (and the regression tests)
# can exercise the full flow without touching /var/lib/tap or /opt/tap.
# Production (systemd unit) sets none of these and uses the defaults.
BUILD_DIR="${TAP_UPDATE_BUILD_DIR:-/var/lib/tap/build/indigo}"
TAP_BIN_DIR="${TAP_UPDATE_TAP_BIN_DIR:-/opt/tap}"
TAP_BIN="${TAP_BIN_DIR}/tap"
TAP_NEW="${TAP_BIN_DIR}/tap.new"
TAP_PREV="${TAP_BIN_DIR}/tap.prev"
TAP_VERSION_FILE="${TAP_BIN_DIR}/.version"
TAP_PATCHES_SHA_FILE="${TAP_BIN_DIR}/.patches.sha256"
TAP_BINARY_SHA_FILE="${TAP_BIN_DIR}/.binary.sha256"
LOCK_FILE="${TAP_UPDATE_LOCK_FILE:-/var/lib/tap/.tap-update-lock}"

# kipclip's own appview checkout on the box holds the downstream patches.
PATCH_DIR="${TAP_UPDATE_PATCH_DIR:-/var/lib/kipclip/source/deploy/tap/patches}"

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

sha256_file() {
  sha256sum "$1" | awk '{print $1}'
}

# Resolve the desired ref to an IMMUTABLE commit sha. Branch names and
# origin/* refs are refused: rebuilding a moving default is the failure
# mode this script exists to prevent.
#
# IMPORTANT: the caller captures THIS FUNCTION'S STDOUT as the ref
# (`DESIRED_REF="$(resolve_ref)"`) — so the sha is the ONLY thing this
# function prints on stdout. All diagnostics go to stderr.
resolve_ref() {
  local pin=""
  if [[ -s "$PIN_FILE" ]]; then
    pin="$(tr -d '[:space:]' < "$PIN_FILE")"
  fi

  local desired
  if [[ -n "$pin" ]]; then
    desired="$pin"
    log "Pin file present: $pin" >&2
  elif [[ -n "${TAP_UPDATE_DEFAULT_REF:-}" ]]; then
    desired="$TAP_UPDATE_DEFAULT_REF"
    log "TAP_UPDATE_DEFAULT_REF override: ${TAP_UPDATE_DEFAULT_REF}" >&2
  else
    desired="$TAP_DEFAULT_BASE_SHA"
    log "Default immutable base: $TAP_DEFAULT_BASE_SHA" >&2
  fi

  if [[ ! "$desired" =~ ^[0-9a-f]{40}$ ]]; then
    err "ref '$desired' is not a 40-hex commit sha. Tracking moving refs " \
      "(branches like origin/main) is DISABLED — pin an immutable commit."
    exit 1
  fi
  echo "$desired"
}

# Apply every downstream patch in PATCH_DIR onto the checked-out base.
# Fail loudly if any patch does not apply: a clean-apply failure means the
# reviewed source changed and the build must not silently proceed.
apply_patches() {
  if [[ ! -d "$PATCH_DIR" ]]; then
    err "patch dir missing at $PATCH_DIR — refusing to build unpatched TAP"
    exit 1
  fi
  local patches
  # bash 3.2-compatible (no mapfile): an empty patch set is refused below.
  patches=()
  while IFS= read -r p; do
    patches+=("$p")
  done < <(find "$PATCH_DIR" -maxdepth 1 -name '*.patch' -type f | sort)
  if [[ ${#patches[@]} -eq 0 ]]; then
    err "no patches found in $PATCH_DIR — refusing to build unpatched TAP"
    exit 1
  fi
  local p
  for p in "${patches[@]}"; do
    sublog "applying $(basename "$p")"
    if ! sudo -u "$TAP_USER" git -C "$BUILD_DIR" apply --check "$p" 2>/dev/null; then
      err "patch $(basename "$p") does NOT apply cleanly on $(git -C "$BUILD_DIR" rev-parse HEAD) — base drift; re-review against a new base instead of building blind"
      exit 1
    fi
    sudo -u "$TAP_USER" git -C "$BUILD_DIR" apply "$p"
  done
  # Record the patch set fingerprint for .patches.sha256.
  ( cd "$PATCH_DIR" && sha256sum ./*.patch ) | sort -k2 > /tmp/tap-patches.sha256
  mv /tmp/tap-patches.sha256 "${TAP_BIN_DIR}/.patches.sha256.new"
  chown "${TAP_USER}:${TAP_GROUP}" "${TAP_BIN_DIR}/.patches.sha256.new"
}

main() {
  require_tool git
  require_tool go
  require_tool curl
  require_tool flock
  require_tool systemctl
  require_tool install
  require_tool sha256sum
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

  local DESIRED_REF
  DESIRED_REF="$(resolve_ref)"

  log "Fetching $REPO_URL"
  if sudo -u "$TAP_USER" git -C "$BUILD_DIR" rev-parse --is-shallow-repository 2>/dev/null | grep -q true; then
    log "Unshallowing clone"
    sudo -u "$TAP_USER" git -C "$BUILD_DIR" fetch --unshallow origin "$DESIRED_REF" >/dev/null 2>&1 || true
  fi
  sudo -u "$TAP_USER" git -C "$BUILD_DIR" fetch --prune origin "$DESIRED_REF" >/dev/null

  if ! DESIRED_SHA="$(sudo -u "$TAP_USER" git -C "$BUILD_DIR" rev-parse --verify "${DESIRED_REF}^{commit}" 2>/dev/null)"; then
    err "cannot resolve $DESIRED_REF in $BUILD_DIR"
    exit 1
  fi
  DESIRED_SHORT="${DESIRED_SHA:0:12}"

  CURRENT_SHA=""
  if [[ -s "$TAP_VERSION_FILE" ]]; then
    CURRENT_SHA="$(tr -d '[:space:]' < "$TAP_VERSION_FILE")"
  fi
  CURRENT_PATCHES=""
  if [[ -s "$TAP_PATCHES_SHA_FILE" ]]; then
    CURRENT_PATCHES="$(tr -d '[:space:]' < "$TAP_PATCHES_SHA_FILE")"
  fi

  log "Building TAP $DESIRED_SHORT (was: ${CURRENT_SHA:0:12})"
  sudo -u "$TAP_USER" git -C "$BUILD_DIR" checkout --quiet "$DESIRED_SHA"

  apply_patches

  # Compute the patch fingerprint now so the already-on-this-build short
  # circuit can compare apples to apples.
  local PATCHES_FP=""
  if [[ -f "${TAP_BIN_DIR}/.patches.sha256.new" ]]; then
    PATCHES_FP="$(tr -d '[:space:]' < "${TAP_BIN_DIR}/.patches.sha256.new")"
    rm -f "${TAP_BIN_DIR}/.patches.sha256.new"
  fi

  if [[ "$CURRENT_SHA" == "$DESIRED_SHA" && "$CURRENT_PATCHES" == "$PATCHES_FP" ]]; then
    sublog "Already on ${DESIRED_SHORT} with the reviewed patch set; nothing to do"
    exit 0
  fi

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

  # Save current binary + recorded SHAs for rollback. First-run leaves
  # .prev absent, which the rollback path handles.
  if [[ -x "$TAP_BIN" ]]; then
    cp -p "$TAP_BIN" "$TAP_PREV"
    cp -p "$TAP_VERSION_FILE" "${TAP_VERSION_FILE}.prev" 2>/dev/null || true
    cp -p "$TAP_PATCHES_SHA_FILE" "${TAP_PATCHES_SHA_FILE}.prev" 2>/dev/null || true
    cp -p "$TAP_BINARY_SHA_FILE" "${TAP_BINARY_SHA_FILE}.prev" 2>/dev/null || true
  fi

  # Atomic rename — same filesystem.
  mv "$TAP_NEW" "$TAP_BIN"
  echo "$DESIRED_SHA" > "$TAP_VERSION_FILE"
  echo "$PATCHES_FP" > "$TAP_PATCHES_SHA_FILE"
  echo "$(sha256_file "$TAP_BIN")" > "$TAP_BINARY_SHA_FILE"
  log "Installed source=$DESIRED_SHA patches=$(echo "$PATCHES_FP" | cut -c1-16)… binary=$(cat "$TAP_BINARY_SHA_FILE")"

  log "Restarting tap.service"
  if ! systemctl restart tap; then
    err "systemctl restart tap FAILED — entering rollback"
    rollback_tap
  fi

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
    rollback_tap
  fi

  log "✅ TAP updated source=$DESIRED_SHA binary=$(cat "$TAP_BINARY_SHA_FILE")"
  log "post-deploy: verify retry_counts stop accelerating — journalctl -u tap --since '10 minutes ago' | grep -c 'retry'"
}

# Restore the previous binary, the recorded sha/version files, restart, and
# re-check health. Runs on restart OR health-check failure — a failed
# `systemctl restart tap` must NOT skip rollback, so both call sites guard
# the restart below instead of letting `set -e` exit the script first.
rollback_tap() {
  if [[ -x "$TAP_PREV" ]]; then
    err "rolling back to previous binary"
    mv "$TAP_PREV" "$TAP_BIN"
    if [[ -s "${TAP_VERSION_FILE}.prev" ]]; then
      mv "${TAP_VERSION_FILE}.prev" "$TAP_VERSION_FILE"
    else
      rm -f "$TAP_VERSION_FILE"
    fi
    if [[ -s "${TAP_PATCHES_SHA_FILE}.prev" ]]; then
      mv "${TAP_PATCHES_SHA_FILE}.prev" "$TAP_PATCHES_SHA_FILE"
    else
      rm -f "$TAP_PATCHES_SHA_FILE"
    fi
    if [[ -s "${TAP_BINARY_SHA_FILE}.prev" ]]; then
      mv "${TAP_BINARY_SHA_FILE}.prev" "$TAP_BINARY_SHA_FILE"
    else
      rm -f "$TAP_BINARY_SHA_FILE"
    fi
    if systemctl restart tap; then
      sleep 2
      if health_ok; then
        err "rollback restored TAP successfully: source=$(cat "$TAP_VERSION_FILE") binary=$(cat "$TAP_BINARY_SHA_FILE")"
      else
        err "rollback ALSO failed health check — manual recovery required"
      fi
    else
      err "rollback restart FAILED — manual recovery required"
    fi
  else
    err "no previous binary to roll back to; manual recovery required"
  fi
  err "check: journalctl -u tap -n 50"
  exit 1
}

main "$@"
