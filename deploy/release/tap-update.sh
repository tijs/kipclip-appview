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
#   0. Re-assert tap:tap ownership + owner-writability on the dedicated
#      build tree ($BUILD_DIR) — a checkout that landed root-owned makes
#      git refuse every tap-user op with "detected dubious ownership";
#      git's safe.directory escape is NEVER used.
#   1. Acquire the build lock (non-blocking — skip if a prior tick is
#      still building).
#   2. Resolve the desired ref: pin file > TAP_UPDATE_DEFAULT_REF (sha
#      required) > $TAP_DEFAULT_BASE_SHA. Refuse branch refs / origin/*.
#   3. Fetch, then hard-reset + clean the build tree to the immutable base
#      sha (a previous tick's applied patch must never survive into the
#      next — reset/clean is what makes consecutive runs reproducible).
#   4. Stage a tap-readable private copy of every patch (fresh mktemp
#      dir, tap:tap 0700, files 0600 — the root-owned source tree is
#      unreadable by tap) and apply each staged copy with `git apply
#      --check` then apply.
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

# TAP's own SQLite db. drift-alert (kipclip user via SupplementaryGroups=tap)
# deletes quarantined TAP repo rows directly in this file, so tap-update —
# the root-owned TAP maintenance flow — enforces the group-write layout on it
# every tick (see ensure_tap_db_group_write). Env-overridable for tests.
TAP_DB="${TAP_UPDATE_TAP_DB_PATH:-/var/lib/tap/tap.db}"

# kipclip's own appview checkout on the box holds the downstream patches.
# It is root-owned and not traversable by tap, so apply_patches stages a
# tap-readable private copy per tick instead of broadening its permissions.
PATCH_DIR="${TAP_UPDATE_PATCH_DIR:-/var/lib/kipclip/source/deploy/tap/patches}"

# tap user owns the build dir + go cache; only the install step needs root.
# Ownership is NOT assumed from bootstrap: every tick re-asserts tap:tap
# ownership + owner-writability on the dedicated build tree (a checkout
# that landed root-owned makes git refuse every tap-user op with "detected
# dubious ownership", and is unwritable by tap).
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

# EXIT-trap cleanup for the patch staging handoff (see apply_patches). A
# RETURN trap does NOT fire when a function exits the shell (set -e
# failure or explicit `exit 1`) — only the EXIT trap does — so this
# covers every failure path plus the success path (cleared after success).
# Both variables are script-global (declared below) because the trap
# fires after the function frame is popped; the `${var:-}` guards keep
# them ref-safe under `set -u`.
cleanup_patch_staging() {
  [[ -n "${PATCH_STAGE_DIR:-}" ]] && rm -rf -- "$PATCH_STAGE_DIR"
  [[ -n "${FP_TMP:-}" ]] && rm -f -- "$FP_TMP"
}

# Stage every patch in PATCH_DIR as a tap-readable private copy inside a
# fresh, unpredictable mktemp dir ($PATCH_STAGE_DIR). The patch SOURCE
# (/var/lib/kipclip/source/deploy/tap/patches on the box) is root-owned
# and intentionally NOT traversable by the tap user, so running git as
# tap on a source path fails with `error: can't open patch ... Permission
# denied` — the v0.24.39 production blocker. The source tree is NEVER
# broadened (no chown/chmod on PATCH_DIR, no safe.directory, no global
# git config): each tick copies the patches byte-identical into a dir
# owned tap:tap mode 0700 with 0600 files — git-as-tap reads the copy and
# nobody else can. The caller installs cleanup_patch_staging as an EXIT
# trap BEFORE calling this, so mktemp/chown/cp failures clean up too.
stage_tap_readable_patches() {
  PATCH_STAGE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/tap-patches.XXXXXX")" || {
    err "mktemp -d failed — cannot stage a tap-readable copy of the patch set"
    exit 1
  }
  chown "${TAP_USER}:${TAP_GROUP}" "$PATCH_STAGE_DIR"
  chmod 0700 "$PATCH_STAGE_DIR"
  local p
  while IFS= read -r p; do
    cp -- "$p" "$PATCH_STAGE_DIR/" || {
      err "cannot stage $(basename "$p") into the tap-readable staging dir — patch source unreadable?"
      exit 1
    }
  done < <(find "$PATCH_DIR" -maxdepth 1 -name '*.patch' -type f | sort)
  chown -R "${TAP_USER}:${TAP_GROUP}" "$PATCH_STAGE_DIR"
  chmod 0600 "$PATCH_STAGE_DIR"/*
  sublog "staged tap-readable patch copies in $PATCH_STAGE_DIR (${TAP_USER}:${TAP_GROUP}, 0700/0600)"
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
  # git apply runs as the tap user, which cannot read the root-owned
  # source dir: stage tap-readable private copies first. The EXIT trap
  # removes the staging handoff on EVERY exit path (set -e failure,
  # explicit exit, or normal return); it is cleared only after the staged
  # copies and the fingerprint temp are consumed.
  trap cleanup_patch_staging EXIT
  stage_tap_readable_patches
  local p
  for p in "${patches[@]}"; do
    sublog "applying $(basename "$p")"
    if ! sudo -u "$TAP_USER" git -C "$BUILD_DIR" apply --check "$PATCH_STAGE_DIR/$(basename "$p")" 2>/dev/null; then
      # Resolve HEAD as TAP for the diagnostic: the build tree is
      # tap:tap-owned, so a root `git rev-parse` here would emit git's
      # `detected dubious ownership` fatal instead of the sha.
      err "patch $(basename "$p") does NOT apply cleanly on $(sudo -u "$TAP_USER" git -C "$BUILD_DIR" rev-parse HEAD 2>/dev/null || printf 'unknown') — base drift; re-review against a new base instead of building blind"
      exit 1
    fi
    sudo -u "$TAP_USER" git -C "$BUILD_DIR" apply "$PATCH_STAGE_DIR/$(basename "$p")"
  done
  # Record the patch set fingerprint for .patches.sha256 from the
  # byte-identical staged copies. Stage it through a root-owned mktemp
  # file and atomic-rename into place — a PREDICTABLE
  # /tmp/tap-patches.sha256 written via `>` as root is a symlink-clobber
  # primitive (a local attacker could pre-create the path pointing at any
  # root-writable victim). FP_TMP is script-global because the cleanup
  # EXIT trap fires after the function frame (and its locals) is popped —
  # a local would be "unbound variable" under set -u.
  FP_TMP="$(mktemp "${TMPDIR:-/tmp}/tap-patches-fp.XXXXXX")" || {
    err "mktemp failed — cannot stage patch fingerprint"
    exit 1
  }
  ( cd "$PATCH_STAGE_DIR" && sha256sum ./*.patch ) | sort -k2 > "$FP_TMP"
  mv "$FP_TMP" "${TAP_BIN_DIR}/.patches.sha256.new"
  chown "${TAP_USER}:${TAP_GROUP}" "${TAP_BIN_DIR}/.patches.sha256.new"
  # Success — both staging artifacts are consumed (dir now unused, temp
  # moved into place): remove the dir and drop the EXIT trap so it cannot
  # linger for the rest of the script.
  rm -rf -- "$PATCH_STAGE_DIR"
  trap - EXIT
}

# Staging handoff for apply_patches: $PATCH_STAGE_DIR is the tap-readable
# private copy of the patch set, $FP_TMP the fingerprint temp. Both are
# script-global so the cleanup EXIT trap (cleanup_patch_staging) can
# reference them after the function frame is popped — locals would be
# "unbound variable" under set -u.
FP_TMP=""
PATCH_STAGE_DIR=""

# drift-alert (kipclip user, SupplementaryGroups=tap) deletes quarantined TAP
# repo rows directly in tap.db. Enforce the group-write layout idempotently
# every tick — never any world bit:
#   dir  /var/lib/tap     tap:tap 2770 (setgid: a recreated tap.db still
#                                       lands in group tap)
#   file /var/lib/tap/tap.db  tap:tap 0660 (group rw, no world)
# tap.service also runs with UMask=0007 so freshly created tap.db files start
# 0660; this step repairs any pre-existing db (e.g. the current 0644 layout)
# and re-asserts the dir. Missing data dir (fresh box before TAP first run):
# skip cleanly.
ensure_tap_db_group_write() {
  local db_dir
  db_dir="$(dirname "$TAP_DB")"
  if [[ ! -d "$db_dir" ]]; then
    log "TAP data dir $db_dir missing — skipping tap.db group-write step"
    return 0
  fi
  chown "${TAP_USER}:${TAP_GROUP}" "$db_dir"
  chmod 2770 "$db_dir"
  if [[ -e "$TAP_DB" ]]; then
    chown "${TAP_USER}:${TAP_GROUP}" "$TAP_DB"
    chmod 0660 "$TAP_DB"
  else
    sublog "tap.db not created yet (first tap.service run creates it; setgid dir + UMask=0007 keep group tap)"
  fi
}

# Make the DEDICATED build tree usable by the tap user, every tick, BEFORE
# any `sudo -u tap git -C "$BUILD_DIR"` runs. Two independent failure modes
# of a root-owned checkout:
#   - git's own safety check: a repository not owned by the invoking user
#     dies with `fatal: detected dubious ownership in repository at ...`
#     (observed in production against /var/lib/tap/build/indigo) — and a
#     matching `safe.directory` escape config is NOT an option (it would
#     bless the path globally for every git user on the box);
#   - even with that check disabled the tree would be unwritable by tap
#     (fetch/reset/clean/apply all write into it).
# Repair = chown -R tap:tap + chmod -R u+rwX, scoped EXACTLY to $BUILD_DIR:
# chown -R operates in physical mode (symlinks are re-owned, never
# followed) and u+rwX only ADDS owner read/write(+x on dirs) — it never
# removes bits and never touches group/other, so this cannot weaken the
# tree for anyone else. Idempotent: no-op cost on a correctly-owned tree.
ensure_build_tree_owned() {
  chown -R "${TAP_USER}:${TAP_GROUP}" "$BUILD_DIR"
  chmod -R u+rwX "$BUILD_DIR"
  sublog "build tree $BUILD_DIR is ${TAP_USER}:${TAP_GROUP}-owned and owner-writable"
}

main() {
  require_tool git
  require_tool go
  require_tool curl
  require_tool flock
  require_tool systemctl
  require_tool install
  require_tool sha256sum
  require_tool chown
  require_tool chmod
  [[ -d "$BUILD_DIR/.git" ]] || {
    err "indigo clone missing at $BUILD_DIR — bootstrap TAP first"
    exit 1
  }
  [[ -d "$TAP_BIN_DIR" ]] || {
    err "tap install dir missing at $TAP_BIN_DIR"
    exit 1
  }

  # Enforce the TAP-side permission contracts BEFORE the lock/exits so they
  # hold even when the tick short-circuits (lock contention, already-on):
  #   1. build tree tap:tap-owned + owner-writable (git as tap refuses a
  #      root-owned checkout: "detected dubious ownership"),
  #   2. tap.db group-write layout.
  ensure_build_tree_owned
  ensure_tap_db_group_write

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

  # Make the DEDICATED build tree EXACTLY the pinned base before applying
  # the reviewed patch. A plain `git checkout <sha>` is a no-op when HEAD
  # is already on that sha, so a previous run's applied patch would survive
  # into the next tick and `git apply --check` would then fail — the timer
  # would stop instead of reporting "already up to date". The tree is
  # script-owned, so reset --hard + clean -fdx (CI-style) makes consecutive
  # ticks reproducible: the tracked-file modifications from the applied
  # patch are discarded by the reset, and untracked leftovers (e.g. an
  # interrupted build's tap-build-out) by the clean.
  #
  # The reset target is ALWAYS the verified immutable DESIRED_SHA resolved
  # above: resolve_ref refuses branch names and origin/* refs, and
  # DESIRED_SHA came from `rev-parse --verify "${DESIRED_REF}^{commit}"`
  # after the fetch — this code can never silently rebuild a moving
  # origin/main.
  sudo -u "$TAP_USER" git -C "$BUILD_DIR" reset --hard --quiet "$DESIRED_SHA"
  sudo -u "$TAP_USER" git -C "$BUILD_DIR" clean -fdx

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
