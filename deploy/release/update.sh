#!/usr/bin/env bash
# Pull-based release update for kipclip on the Hetzner box.
#
# Polled by kipclip-release.timer every 60s. Each tick:
#   1. Acquire the release lock (non-blocking — skip if another tick is
#      already mid-build).
#   2. Fetch tags from GitHub.
#   3. Resolve the desired tag: pin file overrides "latest semver merged
#      into origin/main".
#   4. If desired matches /var/lib/kipclip/current/.version, exit 0.
#   5. Build in /var/lib/kipclip/releases/<tag>/, atomic-swap the
#      `current` symlink, write a SENTRY_RELEASE drop-in, daemon-reload,
#      restart kipclip.
#   6. Health-check /api/health up to 5x. Failure leaves the previous
#      release running -- the swap already happened, so manual rollback
#      is via the pin file or by tagging a fix.
#   7. GC release dirs older than the last 5.
#
# Env knobs (rare, mostly for staging dry-runs):
#   KIPCLIP_RELEASE_REPO_URL  override the GitHub remote URL
#   KIPCLIP_RELEASE_BRANCH    default "main"
#   KIPCLIP_RELEASE_PIN_FILE  default /etc/kipclip/release-pin
#   KIPCLIP_RELEASE_GC_KEEP   default 5
#
# Required tools on PATH: git, deno, systemctl, curl, flock, ln.
set -euo pipefail

REPO_URL="${KIPCLIP_RELEASE_REPO_URL:-https://github.com/tijs/kipclip-appview.git}"
BRANCH="${KIPCLIP_RELEASE_BRANCH:-main}"
PIN_FILE="${KIPCLIP_RELEASE_PIN_FILE:-/etc/kipclip/release-pin}"
GC_KEEP="${KIPCLIP_RELEASE_GC_KEEP:-5}"

KIPCLIP_ROOT="/var/lib/kipclip"
SOURCE_DIR="${KIPCLIP_ROOT}/source"
RELEASES_DIR="${KIPCLIP_ROOT}/releases"
CURRENT_LINK="${KIPCLIP_ROOT}/current"
LOCK_FILE="${KIPCLIP_ROOT}/.release-lock"
DENO_BIN="${DENO_BIN:-/opt/deno/bin/deno}"

SYSTEMD_DROPIN_DIR="/etc/systemd/system/kipclip.service.d"
SYSTEMD_DROPIN_FILE="${SYSTEMD_DROPIN_DIR}/release.conf"
HEALTH_URL="http://127.0.0.1:8000/api/health"

log() { echo "==> $*"; }
sublog() { echo "    $*"; }
err() { echo "ERROR: $*" >&2; }

# Refuse to run if dependencies are missing — produces a clearer error
# than a mid-script crash.
require_tool() {
  if ! command -v "$1" >/dev/null 2>&1; then
    err "required tool not found on PATH: $1"
    exit 1
  fi
}

require_tool git
require_tool curl
require_tool flock
require_tool systemctl
require_tool sudo
[[ -x "$DENO_BIN" ]] || { err "deno binary not found at $DENO_BIN"; exit 1; }

# Acquire lock. Non-blocking — concurrent tick exits 0 silently. Long
# builds (>60s) overlap the next timer firing; flock prevents the race.
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  exit 0
fi

[[ -d "$SOURCE_DIR/.git" ]] || {
  err "source clone missing at $SOURCE_DIR — run deploy/release/bootstrap.sh first"
  exit 1
}

cd "$SOURCE_DIR"

log "Fetching tags from $REPO_URL"
# stdout silenced (stays quiet on the no-op happy path) but stderr
# propagates so a fetch failure shows up in journalctl.
git fetch --tags --prune origin "$BRANCH" >/dev/null

# Resolve desired tag.
PIN=""
if [[ -s "$PIN_FILE" ]]; then
  PIN="$(tr -d '[:space:]' < "$PIN_FILE")"
fi

if [[ -n "$PIN" ]]; then
  log "Pin file present: $PIN"
  if ! git rev-parse --verify "refs/tags/${PIN}" >/dev/null 2>&1; then
    err "pinned tag $PIN does not exist; staying on current"
    exit 1
  fi
  DESIRED_TAG="$PIN"
else
  DESIRED_TAG="$(git tag --sort=-v:refname --merged "origin/${BRANCH}" \
    | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' \
    | head -1 || true)"
  if [[ -z "$DESIRED_TAG" ]]; then
    err "no semver tag found on origin/${BRANCH}; nothing to release"
    exit 0
  fi
fi

log "Desired release: $DESIRED_TAG"

CURRENT_VERSION=""
if [[ -L "$CURRENT_LINK" && -f "${CURRENT_LINK}/.version" ]]; then
  CURRENT_VERSION="$(cat "${CURRENT_LINK}/.version")"
fi

if [[ "$CURRENT_VERSION" == "$DESIRED_TAG" ]]; then
  sublog "Already on $DESIRED_TAG; nothing to do"
  exit 0
fi

log "Releasing $DESIRED_TAG (was: ${CURRENT_VERSION:-none})"

RELEASE_DIR="${RELEASES_DIR}/${DESIRED_TAG}"
# Always start clean. Re-running on a tag means a previous attempt
# failed mid-way; reusing that dir would mix stale files (`git archive |
# tar -x` is additive, so files removed in the new tag would survive).
rm -rf "$RELEASE_DIR"
mkdir -p "$RELEASE_DIR"

# Materialise the tag's tree into the release dir. `git archive | tar`
# avoids a full second .git in the release dir (saves disk + keeps the
# release dir clean of operator-only metadata).
log "Materialising $DESIRED_TAG into $RELEASE_DIR"
git archive --format=tar "$DESIRED_TAG" | tar -x -C "$RELEASE_DIR"

# Build. KIPCLIP_VERSION + KIPCLIP_SHA are consumed by
# scripts/build-frontend.ts to bake release metadata into
# static/manifest.json. The release dir is materialised via
# `git archive | tar -x` and has no .git, so we resolve the sha here in
# the source clone (which does have .git) and pass it through.
RELEASE_SHA="$(git rev-parse --short "$DESIRED_TAG^{commit}")"
log "Building $DESIRED_TAG (sha $RELEASE_SHA)"
(
  cd "$RELEASE_DIR"
  KIPCLIP_VERSION="$DESIRED_TAG" \
    KIPCLIP_SHA="$RELEASE_SHA" \
    "$DENO_BIN" task build
)

echo "$DESIRED_TAG" > "${RELEASE_DIR}/.version"

# Render the systemd drop-in for SENTRY_RELEASE. This is the only
# /etc/systemd/system file the auto-release flow ever writes; the unit
# itself is bootstrap-managed.
log "Writing systemd drop-in for SENTRY_RELEASE=$DESIRED_TAG"
mkdir -p "$SYSTEMD_DROPIN_DIR"
cat > "$SYSTEMD_DROPIN_FILE" <<EOF
[Service]
Environment="SENTRY_RELEASE=${DESIRED_TAG}"
EOF
# Sudoers grants kipclip NOPASSWD on these two commands only
# (see deploy/release/kipclip.sudoers, installed by bootstrap.sh).
sudo /bin/systemctl daemon-reload

# Atomic swap. ln -sfn replaces the symlink atomically on Linux (no
# brief unlinked window).
log "Atomic swap: current -> $RELEASE_DIR"
ln -sfn "$RELEASE_DIR" "$CURRENT_LINK"

# Restart picks up the new working directory + new SENTRY_RELEASE env.
log "Restarting kipclip"
sudo /bin/systemctl restart kipclip

# Health check. Sleep+retry; the deno serve takes ~1s to bind port 8000.
log "Health-checking $HEALTH_URL"
for attempt in 1 2 3 4 5; do
  sleep 1
  if curl -fsS --max-time 3 "$HEALTH_URL" >/dev/null 2>&1; then
    sublog "✅ health OK on attempt $attempt"
    HEALTH_OK=1
    break
  fi
  sublog "attempt $attempt/5: not yet"
done

if [[ "${HEALTH_OK:-0}" != "1" ]]; then
  err "kipclip failed to come up after restart on $DESIRED_TAG"
  err "current symlink is on $DESIRED_TAG; manual recovery may be needed"
  err "check: journalctl -u kipclip -n 50"
  exit 1
fi

# GC: keep the last $GC_KEEP releases plus the current symlink target.
log "GC: keeping last $GC_KEEP releases"
CURRENT_TARGET="$(readlink -f "$CURRENT_LINK" 2>/dev/null || echo "")"
mapfile -t ALL_RELEASES < <(ls -1t "$RELEASES_DIR" 2>/dev/null || true)
KEPT=0
for entry in "${ALL_RELEASES[@]}"; do
  full="${RELEASES_DIR}/${entry}"
  if [[ "$full" == "$CURRENT_TARGET" ]]; then
    continue
  fi
  KEPT=$((KEPT + 1))
  if (( KEPT > GC_KEEP - 1 )); then
    sublog "removing $entry"
    rm -rf "$full"
  fi
done

log "✅ Released $DESIRED_TAG"
