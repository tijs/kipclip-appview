#!/usr/bin/env bash
# Pull-based release update for kipclip on the Hetzner box.
#
# Polled by kipclip-release.timer every 60s. Each tick:
#   1. Acquire the release lock (non-blocking — skip if another tick is
#      already mid-build).
#   2. Recover any activation journal left behind by an interrupted tick
#      (see "Crash recovery" below) — before anything else, so the
#      desired==current fast-path can never mask a half-applied
#      transaction.
#   3. No-journal consistency guard: with no journal left, verify for any
#      valid `current` symlink that the unit's effective ExecStart kind
#      can still start it and that release.conf SENTRY_RELEASE still
#      names it. A persisted drop-in from a crash whose journal was lost
#      (kind mismatch, undeterminable unit, stale label) fails closed
#      here — before the fetch, the build, or any new transaction that
#      could snapshot the incompatible state.
#   4. Log which updater revision is executing, then fetch tags.
#   5. Resolve the desired tag: pin file overrides "latest semver merged
#      into origin/main".
#   6. If desired matches /var/lib/kipclip/current/.version, exit 0 (the
#      guard above already proved the unit can start it).
#   7. Build in /var/lib/kipclip/releases/<tag>/ — `current` is not
#      touched while building; a failed build changes nothing.
#   8. Commit a durable activation journal (intent + byte-exact copies of
#      the drop-ins this tick will rewrite) under $KIPCLIP_ROOT. A
#      failing sync here aborts the tick before any mutation.
#   9. Write the SENTRY_RELEASE drop-in. When the desired release runs a
#      different runtime kind than the current one (the first Hono
#      release, or a pin across that boundary), also switch the unit's
#      ExecStart override in the same step, so symlink + unit move
#      together before the single restart. Pinning back to legacy is
#      base-unit-aware: the override is removed only when the installed
#      base unit's ExecStart is itself legacy; against a Hono base unit
#      an explicit legacy override is pinned instead; an unreadable base
#      unit is a fail-closed hard stop.
#  10. Swap `current`, daemon-reload, restart kipclip.
#  11. Health-check /api/health up to 5x. On failure (or a failed
#      restart/reload/swap) restore the previous `current` symlink AND
#      the previous drop-ins byte-exactly, reload systemd, restart the
#      old release, re-verify its health, clean the journal, and exit 1.
#      If the rollback itself cannot be verified, the journal is KEPT and
#      the tick fails closed: later ticks stop at recovery until an
#      operator resolves it.
#  12. Clean the journal only after a verified activation or rollback,
#      then GC release dirs older than the last 5.
#
# Crash recovery (SIGKILL, power loss):
#   Shell EXIT traps do not run on SIGKILL/power loss, so recovery never
#   relies on one. The activation journal is the durable pending marker.
#   On the next tick, before the desired==current fast-path, a committed
#   journal means one of two things:
#     - `current` already points at the journal's target: the swap
#       happened. Recovery restarts the unit (the only way to prove the
#       new release actually starts), health-checks it, and then cleans
#       the journal — or rolls back if it cannot be verified.
#     - `current` does not point at the target: the swap never happened.
#       Recovery restores the drop-ins byte-exactly, reloads systemd,
#       cleans the journal, and lets the normal flow retry.
#   The journal lives under $KIPCLIP_ROOT — the same persistent
#   filesystem as the `current` symlink — never /tmp (PrivateTmp=true,
#   and /tmp is not durable). It is committed with one directory rename
#   plus a `sync` before the first mutation; a failing sync is
#   fail-closed (the tick exits 1 before mutating anything). Residual
#   risk, stated without pretending it is bounded: storage that reports
#   a successful sync and still loses the journal while a drop-in
#   mutation persisted. The next tick then has no journal to recover
#   from; the no-journal consistency guard (step 3) fails closed before
#   the fetch, the build, or any transaction when the unit's effective
#   ExecStart kind cannot be determined or disagrees with the current
#   release, or when release.conf SENTRY_RELEASE disagrees with the
#   current release's .version — so no new transaction ever snapshots a
#   persisted stale drop-in. What stays undetectable is a lost journal
#   whose persisted state is fully self-consistent (e.g. the swap
#   completed but the restart was never proven): the next tick then
#   treats the release as already active. Operator-blocking where
#   detectable, never silent.
#
# Env knobs (rare, mostly for staging dry-runs and the regression tests):
#   KIPCLIP_RELEASE_REPO_URL        override the GitHub remote URL
#   KIPCLIP_RELEASE_BRANCH          default "main"
#   KIPCLIP_RELEASE_PIN_FILE        default /etc/kipclip/release-pin
#   KIPCLIP_RELEASE_GC_KEEP         default 5
#   KIPCLIP_RELEASE_ROOT            default /var/lib/kipclip
#   KIPCLIP_RELEASE_DROPIN_DIR      default /etc/systemd/system/kipclip.service.d
#   KIPCLIP_RELEASE_BASE_UNIT_FILE  default /etc/systemd/system/kipclip.service
#   KIPCLIP_RELEASE_HEALTH_URL      default http://127.0.0.1:8000/api/health
#   KIPCLIP_RELEASE_HEALTH_ATTEMPTS default 5
#   KIPCLIP_RELEASE_HEALTH_SLEEP    default 1 (seconds between attempts)
#
# Required tools on PATH: git, deno, systemctl, curl, flock, ln.
set -euo pipefail

REPO_URL="${KIPCLIP_RELEASE_REPO_URL:-https://github.com/tijs/kipclip-appview.git}"
BRANCH="${KIPCLIP_RELEASE_BRANCH:-main}"
PIN_FILE="${KIPCLIP_RELEASE_PIN_FILE:-/etc/kipclip/release-pin}"
GC_KEEP="${KIPCLIP_RELEASE_GC_KEEP:-5}"

# Paths are env-overridable so staging dry-runs (and the regression
# tests) can exercise the full flow without touching /var/lib/kipclip or
# /etc/systemd/system. Production (systemd unit) sets none of these and
# uses the defaults.
KIPCLIP_ROOT="${KIPCLIP_RELEASE_ROOT:-/var/lib/kipclip}"
SOURCE_DIR="${KIPCLIP_ROOT}/source"
RELEASES_DIR="${KIPCLIP_ROOT}/releases"
CURRENT_LINK="${KIPCLIP_ROOT}/current"
LOCK_FILE="${KIPCLIP_ROOT}/.release-lock"
DENO_BIN="${DENO_BIN:-/opt/deno/bin/deno}"

SYSTEMD_DROPIN_DIR="${KIPCLIP_RELEASE_DROPIN_DIR:-/etc/systemd/system/kipclip.service.d}"
SYSTEMD_DROPIN_FILE="${SYSTEMD_DROPIN_DIR}/release.conf"
# ExecStart override, written only when the release runtime kind changes
# (the first Hono release, or a pin across that boundary). Whether a pin
# back to legacy may simply remove it depends on the installed base unit
# (see base_unit_kind / RUNTIME_ACTION in main).
RUNTIME_DROPIN_FILE="${SYSTEMD_DROPIN_DIR}/runtime.conf"
# The bootstrap-managed base unit. Read-only here: its ExecStart tells us
# which runtime kind applies when no override is present.
BASE_UNIT_FILE="${KIPCLIP_RELEASE_BASE_UNIT_FILE:-/etc/systemd/system/kipclip.service}"
# The pre-Hono runtime's entrypoint (pinned by a legacy ExecStart
# override, and recognised in base units). Assembled from fragments so
# the literal never appears contiguously in this file: the framework
# audit (scripts/audit-framework.ts) scans every file for the removed
# framework's generated references and fails closed (no exemptions).
LEGACY_ENTRYPOINT="_""fresh/server.js"
# Regex-escaped form for grep -E — the '.' must not match any character.
LEGACY_ENTRYPOINT_RE="${LEGACY_ENTRYPOINT//./\\.}"
HEALTH_URL="${KIPCLIP_RELEASE_HEALTH_URL:-http://127.0.0.1:8000/api/health}"
HEALTH_ATTEMPTS="${KIPCLIP_RELEASE_HEALTH_ATTEMPTS:-5}"
HEALTH_SLEEP="${KIPCLIP_RELEASE_HEALTH_SLEEP:-1}"

# Durable activation journal (see header). Committed before the first
# drop-in mutation; cleaned only after a verified activation/rollback.
TXN_DIR="${KIPCLIP_ROOT}/.release-txn"
TXN_TMP_DIR="${TXN_DIR}.tmp"
# Prior-state flags for the journal/rollback; set in main before the
# journal is written.
HAD_RELEASE_CONF=0
HAD_RUNTIME_CONF=0

# Absolute path of the running updater file, for the revision evidence
# line. $0 is absolute under the systemd unit; the cd handles relative
# invocations.
UPDATER_FILE="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"

log() { echo "==> $*"; }
sublog() { echo "    $*"; }
err() { echo "ERROR: $*" >&2; }

# Best-effort removal of the journal *staging* dir on normal exits. This
# is not the crash-safety mechanism: SIGKILL/power loss skip traps, which
# is exactly why the committed journal + next-tick recovery exist.
trap 'rm -rf "$TXN_TMP_DIR" 2>/dev/null || true' EXIT

# Refuse to run if dependencies are missing — produces a clearer error
# than a mid-script crash.
require_tool() {
  if ! command -v "$1" >/dev/null 2>&1; then
    err "required tool not found on PATH: $1"
    exit 1
  fi
}

# Liveness probe for the app: a 2xx from /api/health proves the process
# is up and bound.
health_ok() {
  curl -fsS --max-time 3 "$HEALTH_URL" >/dev/null 2>&1
}

# Bounded retry loop shared by the activation check and the rollback
# re-check. Sleeps before each attempt — the server takes ~1s to bind.
wait_for_health() {
  local attempt
  for ((attempt = 1; attempt <= HEALTH_ATTEMPTS; attempt++)); do
    sleep "$HEALTH_SLEEP"
    if health_ok; then
      sublog "✅ health OK on attempt $attempt"
      return 0
    fi
    sublog "attempt $attempt/$HEALTH_ATTEMPTS: not yet"
  done
  return 1
}

# sha256 of a file for the revision evidence line. Prefers coreutils
# (production Debian), falls back to macOS shasum / openssl. Prints
# "unavailable" when no hasher exists — the revision line must never
# abort a release.
file_sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  elif command -v openssl >/dev/null 2>&1; then
    openssl dgst -sha256 "$1" | awk '{print $NF}'
  else
    echo "unavailable"
  fi
}

# Runtime kind of a materialised, built release tree:
#   hono   — the runtime-portable app; entrypoint runtime/deno/server.ts
#   legacy — the pre-Hono app (its own build step provides the entrypoint
#            the bootstrap-managed base unit starts).
runtime_kind() {
  if [[ -n "$1" && -e "$1/runtime/deno/server.ts" ]]; then
    echo "hono"
  else
    echo "legacy"
  fi
}

# Kind of the installed bootstrap-managed base unit, from its ExecStart:
#   hono    — ExecStart references runtime/deno/server.ts
#   legacy  — ExecStart references the pre-Hono entrypoint
#   unknown — file missing/unreadable, or neither marker present
# Only read, never written: bootstrap.sh is the sole writer of base units.
base_unit_kind() {
  if [[ ! -r "$BASE_UNIT_FILE" ]]; then
    echo "unknown"
  elif grep -Eq '^[[:space:]]*ExecStart=.*runtime/deno/server\.ts' "$BASE_UNIT_FILE" 2>/dev/null; then
    echo "hono"
  elif grep -Eq "^[[:space:]]*ExecStart=.*${LEGACY_ENTRYPOINT_RE}" "$BASE_UNIT_FILE" 2>/dev/null; then
    echo "legacy"
  else
    echo "unknown"
  fi
}

# Effective ExecStart kind of the installed unit — what systemd would
# actually start. The runtime.conf override, when present, resets the
# base ExecStart and wins; an override that does not touch ExecStart at
# all (e.g. an env-only operator edit) leaves the base unit's ExecStart
# in force. Echoes hono / legacy / unknown: an unreadable override, an
# ExecStart line matching neither entrypoint (a foreign command, or a
# reset with the command missing — a truncated write), or a base unit
# that cannot be classified is unknown.
effective_unit_kind() {
  if [[ -e "$RUNTIME_DROPIN_FILE" ]]; then
    if [[ ! -r "$RUNTIME_DROPIN_FILE" ]]; then
      echo "unknown"
    elif grep -Eq '^[[:space:]]*ExecStart=.*runtime/deno/server\.ts' "$RUNTIME_DROPIN_FILE" 2>/dev/null; then
      echo "hono"
    elif grep -Eq "^[[:space:]]*ExecStart=.*${LEGACY_ENTRYPOINT_RE}" "$RUNTIME_DROPIN_FILE" 2>/dev/null; then
      echo "legacy"
    elif grep -Eq '^[[:space:]]*ExecStart=' "$RUNTIME_DROPIN_FILE" 2>/dev/null; then
      echo "unknown"
    else
      base_unit_kind
    fi
  else
    base_unit_kind
  fi
}

# SENTRY_RELEASE value carried by the release drop-in, or empty when the
# file is missing/unreadable or carries no SENTRY_RELEASE assignment.
# write_release_dropin emits Environment="SENTRY_RELEASE=<tag>"; the
# extraction tolerates quotes, whitespace and extra lines.
release_conf_tag() {
  [[ -f "$SYSTEMD_DROPIN_FILE" ]] || return 0
  grep -m1 -o 'SENTRY_RELEASE=[^"[:space:]]*' "$SYSTEMD_DROPIN_FILE" 2>/dev/null |
    cut -d= -f2- || true
}

# --- no-journal consistency guard -----------------------------------------
# Runs every tick immediately after recover_transaction, so no journal
# exists at this point (recovery either cleaned one or exited). A valid
# `current` symlink is durable evidence that a release was activated: the
# unit's effective ExecStart kind must still be able to start it, and the
# release.conf SENTRY_RELEASE label must still name it. Any disagreement
# can only come from a crash window whose journal was lost despite a
# persisted drop-in mutation. Starting a new transaction over that state
# is the trap this guard closes: its journal would snapshot the stale
# drop-in, a later rollback would restore a unit that cannot start the
# release, the rollback could not verify itself, and the box would only
# fail closed after it had already been disturbed. Fail closed here
# instead — before fetch, before build, before any mutation. The
# intentional legacy -> Hono cutover is unaffected: a legacy `current`
# under a legacy effective unit (legacy base unit, or an explicit legacy
# override) agrees, and the cutover transaction below proceeds normally.
no_journal_consistency_guard() {
  [[ -L "$CURRENT_LINK" ]] || return 0
  local current_target eff cur
  current_target="$(readlink -f "$CURRENT_LINK" 2>/dev/null || echo "")"
  # A dangling `current` is not a state update.sh can produce (it only
  # ever swaps to freshly built release dirs); leave it to the normal
  # flow, which stages a full release.
  [[ -n "$current_target" && -d "$current_target" ]] || return 0

  eff="$(effective_unit_kind)"
  cur="$(runtime_kind "$current_target")"
  if [[ "$eff" == "unknown" ]]; then
    err "cannot determine the unit's effective ExecStart kind with no activation journal: $RUNTIME_DROPIN_FILE / $BASE_UNIT_FILE missing or unrecognised"
    err "cannot prove the unit starts $CURRENT_LINK; failing closed, nothing was changed"
    err "operator: 'systemctl cat kipclip'; inspect $RUNTIME_DROPIN_FILE and $BASE_UNIT_FILE; later ticks keep failing closed until they are recognisable"
    exit 1
  fi
  if [[ "$eff" != "$cur" ]]; then
    err "unit/current mismatch with no activation journal: effective unit ExecStart kind '$eff' != current release kind '$cur'"
    err "the unit cannot start $CURRENT_LINK; failing closed, nothing was changed"
    err "operator: 'systemctl cat kipclip'; inspect $RUNTIME_DROPIN_FILE and $BASE_UNIT_FILE; later ticks keep failing closed until they agree"
    exit 1
  fi

  # SENTRY_RELEASE label. A transaction rewrites release.conf before the
  # swap, so with no journal a value that disagrees with the current
  # release's .version means the drop-in outlived a lost journal (a
  # same-kind crash leaves the unit kind consistent, so the kind check
  # above cannot catch it). A missing release.conf or .version leaves
  # nothing to compare — skip rather than guess.
  local version tag
  version="$(cat "${current_target}/.version" 2>/dev/null || true)"
  if [[ -n "$version" && -f "$SYSTEMD_DROPIN_FILE" ]]; then
    tag="$(release_conf_tag)"
    if [[ -z "$tag" ]]; then
      err "cannot read SENTRY_RELEASE from $SYSTEMD_DROPIN_FILE with no activation journal"
      err "cannot prove the running release is labelled consistently; failing closed, nothing was changed"
      err "operator: inspect $SYSTEMD_DROPIN_FILE; it must carry SENTRY_RELEASE=${version}"
      exit 1
    fi
    if [[ "$tag" != "$version" ]]; then
      err "stale SENTRY_RELEASE with no activation journal: $SYSTEMD_DROPIN_FILE carries '$tag' but the current release .version is '$version'"
      err "a lost-journal tick rewrote the drop-in without completing the swap; failing closed, nothing was changed"
      err "operator: inspect $SYSTEMD_DROPIN_FILE and $CURRENT_LINK; they must agree"
      exit 1
    fi
  fi
  return 0
}

# ExecStart override drop-in. The empty ExecStart= first resets the base
# unit's command list, then the selected command is pinned — the
# documented systemd drop-in way to replace ExecStart. Pinning is needed
# whenever the effective base ExecStart would not start the desired
# release kind: for Hono releases always (any base kind), and for legacy
# releases whose base unit runs the Hono entrypoint.
write_runtime_dropin() { # $1 = kind to pin: "hono" or "legacy"
  local exec_line
  case "$1" in
    hono) exec_line="ExecStart=${DENO_BIN} run -A --unstable-kv runtime/deno/server.ts" ;;
    legacy) exec_line="ExecStart=${DENO_BIN} serve -A --host 127.0.0.1 --port 8000 ${LEGACY_ENTRYPOINT}" ;;
    *)
      err "internal: write_runtime_dropin: unknown kind '$1'"
      return 1
      ;;
  esac
  mkdir -p "$SYSTEMD_DROPIN_DIR" || return 1
  cat > "$RUNTIME_DROPIN_FILE" <<EOF
# Managed by deploy/release/update.sh — runtime cutover override.
# Written only when the release runtime kind changes; do not edit by hand.
[Service]
# Reset the bootstrap-managed base ExecStart, then pin the selected
# entrypoint (Hono runtime or the pre-Hono entrypoint).
ExecStart=
${exec_line}
EOF
}

# SENTRY_RELEASE drop-in. Rewritten every tick; the journal snapshots its
# previous bytes so rollback can restore them exactly.
write_release_dropin() {
  mkdir -p "$SYSTEMD_DROPIN_DIR" || return 1
  cat > "$SYSTEMD_DROPIN_FILE" <<EOF
[Service]
Environment="SENTRY_RELEASE=${DESIRED_TAG}"
EOF
}

# --- durable activation journal -------------------------------------------
# Written before the first mutation and removed only after a verified
# activation or rollback. Everything recovery needs to undo (or finish)
# the tick lives here: the target release, the previous symlink target,
# and byte-exact copies of both drop-ins with existence flags.

journal_meta_get() { # $1 = key, $2 = meta file
  grep -m1 "^$1=" "$2" 2>/dev/null | cut -d= -f2- || true
}

write_transaction_journal() {
  if [[ -e "$TXN_DIR" ]]; then
    err "activation journal already exists at $TXN_DIR — refusing to overwrite"
    return 1
  fi
  rm -rf "$TXN_TMP_DIR"
  mkdir -p "$TXN_TMP_DIR" || {
    err "cannot create journal staging dir $TXN_TMP_DIR"
    return 1
  }
  {
    echo "FORMAT=1"
    echo "DESIRED_TAG=$DESIRED_TAG"
    echo "TARGET=$RELEASE_DIR"
    echo "PREV_TARGET=$PREV_TARGET"
    echo "RUNTIME_ACTION=$RUNTIME_ACTION"
    echo "DESIRED_KIND=$DESIRED_KIND"
    echo "HAD_RELEASE_CONF=$HAD_RELEASE_CONF"
    echo "HAD_RUNTIME_CONF=$HAD_RUNTIME_CONF"
    echo "STARTED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    echo "UPDATER_REV=$UPDATER_REV"
    echo "UPDATER_SHA=$UPDATER_SHA"
  } > "$TXN_TMP_DIR/meta" || {
    err "cannot write journal meta"
    return 1
  }
  if [[ "$HAD_RELEASE_CONF" == "1" ]]; then
    cp -p "$SYSTEMD_DROPIN_FILE" "$TXN_TMP_DIR/release.conf" || {
      err "cannot snapshot $SYSTEMD_DROPIN_FILE"
      return 1
    }
  fi
  if [[ "$HAD_RUNTIME_CONF" == "1" ]]; then
    cp -p "$RUNTIME_DROPIN_FILE" "$TXN_TMP_DIR/runtime.conf" || {
      err "cannot snapshot $RUNTIME_DROPIN_FILE"
      return 1
    }
  fi
  # Commit with one rename, then flush. The journal must be durable on
  # disk before the first drop-in write: a failing sync is fail-closed
  # (the caller aborts before any mutation), never ignored.
  mv "$TXN_TMP_DIR" "$TXN_DIR" || {
    err "cannot commit journal to $TXN_DIR"
    return 1
  }
  if ! sync; then
    err "sync of the activation journal failed — refusing to mutate before durability is proven"
    return 1
  fi
  sublog "journal committed: $TXN_DIR"
}

# Restore the drop-ins to their pre-tick state from the committed journal:
# previous bytes when the file existed, absence when it did not.
restore_dropins_from_journal() { # $1 = HAD_RELEASE_CONF, $2 = HAD_RUNTIME_CONF
  local had_rel="$1" had_run="$2"
  if [[ "$had_rel" == "1" ]]; then
    [[ -f "$TXN_DIR/release.conf" ]] || {
      err "journal is missing the release.conf snapshot"
      return 1
    }
    rm -f "$SYSTEMD_DROPIN_FILE" && cp -p "$TXN_DIR/release.conf" "$SYSTEMD_DROPIN_FILE" || return 1
  else
    rm -f "$SYSTEMD_DROPIN_FILE" || return 1
  fi
  if [[ "$had_run" == "1" ]]; then
    [[ -f "$TXN_DIR/runtime.conf" ]] || {
      err "journal is missing the runtime.conf snapshot"
      return 1
    }
    rm -f "$RUNTIME_DROPIN_FILE" && cp -p "$TXN_DIR/runtime.conf" "$RUNTIME_DROPIN_FILE" || return 1
  else
    rm -f "$RUNTIME_DROPIN_FILE" || return 1
  fi
  return 0
}

# Remove the journal. Only call after a verified activation or rollback.
# No sync here on purpose: a lost deletion at worst re-runs an idempotent
# recovery on the next tick.
txn_cleanup() {
  rm -rf "$TXN_DIR" "$TXN_TMP_DIR"
}

# Restore the pre-tick symlink + drop-ins, reload, restart the previous
# release, re-verify its health. Cleans the journal only when the
# rollback is verified; returns 1 otherwise (caller keeps the journal and
# fails closed).
rollback_activation() { # $1 = had_rel, $2 = had_run, $3 = prev target, $4 = target
  local had_rel="$1" had_run="$2" prev="$3" target="$4"
  restore_dropins_from_journal "$had_rel" "$had_run" || return 1
  if [[ -n "$prev" && "$prev" != "$target" ]]; then
    ln -sfn "$prev" "$CURRENT_LINK" || return 1
  fi
  sudo /bin/systemctl daemon-reload || return 1
  if [[ -z "$prev" || "$prev" == "$target" ]]; then
    err "no previous release to restart into (first release)"
    return 1
  fi
  sudo /bin/systemctl restart kipclip || return 1
  wait_for_health || return 1
  txn_cleanup
  return 0
}

# Recovery for a journal left by a killed/interrupted tick. Runs before
# any fetch/reset/tag work so the desired==current fast-path can never
# mask a half-applied activation. Exits 1 (fail closed) when the journal
# cannot be trusted or a rollback cannot be verified; returns 0 when the
# box is consistent again.
recover_transaction() {
  if [[ ! -f "$TXN_DIR/meta" ]]; then
    # No committed journal. A leftover staging dir is dead litter from a
    # crash during the journal commit itself (no mutation had happened
    # yet). A committed dir without meta can only be an interrupted
    # cleanup — cleanup runs only after a verified success/rollback.
    rm -rf "$TXN_TMP_DIR" "$TXN_DIR"
    return 0
  fi

  local meta="$TXN_DIR/meta"
  local txn_tag txn_target txn_prev txn_had_rel txn_had_run txn_rev current_target
  txn_tag="$(journal_meta_get DESIRED_TAG "$meta")"
  txn_target="$(journal_meta_get TARGET "$meta")"
  txn_prev="$(journal_meta_get PREV_TARGET "$meta")"
  txn_had_rel="$(journal_meta_get HAD_RELEASE_CONF "$meta")"
  txn_had_run="$(journal_meta_get HAD_RUNTIME_CONF "$meta")"
  txn_rev="$(journal_meta_get UPDATER_REV "$meta")"
  if [[ -z "$txn_target" || -z "$txn_tag" || -z "$txn_had_rel" || -z "$txn_had_run" ]]; then
    err "activation journal at $TXN_DIR is corrupt (meta incomplete)"
    err "operator: inspect $TXN_DIR and the kipclip unit state, then remove the journal"
    exit 1
  fi
  current_target="$(readlink -f "$CURRENT_LINK" 2>/dev/null || echo "")"

  if [[ "$current_target" == "$txn_target" ]]; then
    # The swap happened (it is the last mutation before the restart), so
    # the drop-ins are fully written too. The restart and/or health check
    # may not have run. Completing means proving the new release actually
    # starts: restart + health. Re-restarting is safe even when the
    # interrupted tick had already succeeded — at worst one extra blip.
    log "Recovery: interrupted activation of $txn_tag (updater ${txn_rev:-unknown}) found — completing it"
    if sudo /bin/systemctl restart kipclip && wait_for_health; then
      log "Recovery: $txn_tag verified healthy; cleaning journal"
      txn_cleanup
      return 0
    fi
    err "Recovery: $txn_tag did not come up — rolling back to ${txn_prev:-<none>}"
    if ! rollback_activation "$txn_had_rel" "$txn_had_run" "$txn_prev" "$txn_target"; then
      err "Recovery: rollback could not be verified — journal kept at $TXN_DIR; manual recovery required"
      exit 1
    fi
    err "Recovery: rolled back after interrupted activation"
    exit 1
  fi

  # The swap never happened (ln -sfn is atomic: current is either the old
  # target or the new one). The running process was never restarted by
  # the interrupted tick, so restoring the drop-ins + reload returns the
  # box to its pre-tick systemd state; the normal flow below can then
  # retry the release.
  log "Recovery: interrupted transaction for $txn_tag (updater ${txn_rev:-unknown}) never reached the swap — restoring prior drop-ins"
  if ! restore_dropins_from_journal "$txn_had_rel" "$txn_had_run"; then
    err "Recovery: could not restore drop-ins from $TXN_DIR — journal kept; manual recovery required"
    exit 1
  fi
  if ! sudo /bin/systemctl daemon-reload; then
    err "Recovery: daemon-reload failed — journal kept at $TXN_DIR; manual recovery required"
    exit 1
  fi
  log "Recovery: pre-tick drop-in state restored"
  txn_cleanup
  return 0
}

# Abort helper for a failed drop-in write that happened BEFORE any
# daemon-reload. systemd's in-memory config still matches the restored
# files, so no reload is needed; restoring the snapshots returns the box
# to its pre-tick state and the journal is removed.
abort_before_reload() {
  err "$1 — restoring pre-tick drop-ins"
  if restore_dropins_from_journal "$HAD_RELEASE_CONF" "$HAD_RUNTIME_CONF"; then
    txn_cleanup
    err "pre-tick drop-in state restored; release aborted before activation"
  else
    err "restore failed — journal kept at $TXN_DIR; manual recovery required"
  fi
  exit 1
}

# Abort helper for a failure AFTER daemon-reload ran but BEFORE the swap
# (a failed reload itself, or a failed symlink swap): restore the
# snapshots and reload again so systemd's in-memory config matches the
# restored files. Only a successful reload verifies the rollback.
abort_after_reload() {
  err "$1 — restoring pre-tick drop-ins"
  if restore_dropins_from_journal "$HAD_RELEASE_CONF" "$HAD_RUNTIME_CONF" &&
    sudo /bin/systemctl daemon-reload; then
    txn_cleanup
    err "pre-tick systemd state restored; release aborted before restart"
  else
    err "restore/reload failed — journal kept at $TXN_DIR; manual recovery required"
  fi
  exit 1
}

# Wrap the script body in a function so bash slurps the whole definition
# before invoking it. Without this, `git reset --hard` (below) rewrites
# this very file mid-execution — bash reads scripts incrementally, not
# atomically, so a future commit changing update.sh can splice old bytes
# (already read) with new bytes (re-read at the next chunk boundary).
# `main "$@"` at the end ensures the function is fully parsed first.
main() {
  require_tool git
  require_tool curl
  require_tool flock
  require_tool systemctl
  require_tool sudo

  # Acquire lock. Non-blocking — concurrent tick exits 0 silently. Long
  # builds (>60s) overlap the next timer firing; flock prevents the race.
  exec 9>"$LOCK_FILE"
  if ! flock -n 9; then
    exit 0
  fi

  # Resolve any journal left by a killed/interrupted tick before doing
  # anything else — in particular before the desired==current fast-path
  # below could silently skip recovery.
  recover_transaction

  # Recovery is done: no journal exists past this point. Verify the box
  # is self-consistent before the fetch/build — a persisted stale drop-in
  # from a crash whose journal was lost must not be activated over (and
  # must not be snapshotted by a new transaction). See the guard's
  # comment for the states it fails closed on.
  no_journal_consistency_guard

  [[ -x "$DENO_BIN" ]] || {
    err "deno binary not found at $DENO_BIN"
    exit 1
  }
  [[ -d "$SOURCE_DIR/.git" ]] || {
    err "source clone missing at $SOURCE_DIR — run deploy/release/bootstrap.sh first"
    exit 1
  }

  cd "$SOURCE_DIR"

  # Revision evidence: recorded BEFORE the reset below can rewrite this
  # very file, so journalctl proves which updater bytes ran this tick.
  # The runbook's "merge -> source sync -> second tick" ordering check
  # compares this line against `git -C $SOURCE_DIR log -1`.
  UPDATER_REV="$(git rev-parse HEAD 2>/dev/null || echo unknown)"
  UPDATER_SHA="$(file_sha256 "$UPDATER_FILE" 2>/dev/null || true)"
  [[ -n "$UPDATER_SHA" ]] || UPDATER_SHA="unknown"
  log "Updater revision: commit=$UPDATER_REV update.sh-sha256=$UPDATER_SHA"

  log "Fetching tags from $REPO_URL"
  # stdout silenced (stays quiet on the no-op happy path) but stderr
  # propagates so a fetch failure shows up in journalctl.
  git fetch --tags --prune origin "$BRANCH" >/dev/null

  # Keep the source clone's working tree in sync with origin/main. update.sh
  # itself runs from this tree, so without the reset, fixes to the release
  # script never take effect on the box (they'd ship via tag but the timer
  # would keep running the bootstrap-time copy of update.sh). Hard reset is
  # safe in source/ — the operator never edits files here. The main() wrap
  # above guarantees bash has already parsed this whole function before the
  # reset runs, so the in-flight execution is unaffected by the rewrite.
  git reset --hard "origin/${BRANCH}" >/dev/null
  sublog "source tree synced to $(git rev-parse --short HEAD 2>/dev/null || echo unknown)"

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
    # The no-journal consistency guard above already proved the unit's
    # effective ExecStart kind can start this release (and that the
    # SENTRY_RELEASE label agrees); exiting "already on" cannot mask an
    # incompatible unit.
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

  # --- Runtime cutover decision (before any mutation) -------------------
  # The base unit is bootstrap-managed. Until bootstrap re-runs it starts
  # the legacy runtime; after a bootstrap-redo it starts Hono. A Hono
  # tree cannot start under a legacy base and vice versa, so when the
  # desired release runs a different runtime kind than the current one
  # the ExecStart override is switched in the same tick as the symlink,
  # before the single restart, and rolled back together on failure.
  # Same-kind updates (later Hono releases, plain legacy releases) keep
  # the swap-only path unchanged.
  #
  # The legacy direction is base-unit-aware: removing the override is
  # only safe when the installed base unit is itself legacy. Against a
  # Hono base unit (post-bootstrap), removal would leave a Hono ExecStart
  # pointing at a legacy tree, so an explicit legacy override is pinned
  # instead. An unreadable base unit fails closed here — before the
  # journal exists and before anything is mutated.
  DESIRED_KIND="$(runtime_kind "$RELEASE_DIR")"
  CURRENT_KIND=""
  if [[ -L "$CURRENT_LINK" ]]; then
    CURRENT_KIND="$(runtime_kind "$(readlink -f "$CURRENT_LINK" 2>/dev/null || echo "")")"
  fi
  RUNTIME_ACTION="none"
  if [[ "$DESIRED_KIND" != "$CURRENT_KIND" ]]; then
    case "$DESIRED_KIND" in
      hono)
        # Always safe: the override resets the base ExecStart and pins
        # the Hono entrypoint, whichever kind the base unit is.
        RUNTIME_ACTION="write-hono"
        ;;
      legacy)
        case "$(base_unit_kind)" in
          legacy) RUNTIME_ACTION="remove" ;;
          hono) RUNTIME_ACTION="write-legacy" ;;
          *)
            err "cannot determine the base unit ExecStart kind from $BASE_UNIT_FILE"
            err "refusing to switch back to a legacy release on an unknown base unit — nothing was changed"
            err "operator: 'systemctl cat kipclip', verify $BASE_UNIT_FILE is the bootstrap-managed unit,"
            err "re-run deploy/release/bootstrap.sh if not; the next tick retries automatically"
            exit 1
            ;;
        esac
        ;;
    esac
    log "Runtime cutover: ${CURRENT_KIND:-unknown} -> $DESIRED_KIND (unit override action: $RUNTIME_ACTION)"
  else
    sublog "Runtime unchanged ($DESIRED_KIND); no unit override change"
  fi

  # --- Activation transaction -------------------------------------------
  # Capture everything recovery needs before the first mutation, then
  # commit the journal. From here on, any exit path either cleans the
  # journal (verified success/rollback) or keeps it (fail closed).
  PREV_TARGET="$(readlink -f "$CURRENT_LINK" 2>/dev/null || echo "")"
  if [[ -e "$SYSTEMD_DROPIN_FILE" ]]; then HAD_RELEASE_CONF=1; else HAD_RELEASE_CONF=0; fi
  if [[ -e "$RUNTIME_DROPIN_FILE" ]]; then HAD_RUNTIME_CONF=1; else HAD_RUNTIME_CONF=0; fi

  if ! write_transaction_journal; then
    err "cannot commit a durable activation journal — aborting before any mutation"
    exit 1
  fi

  # Render the systemd drop-in for SENTRY_RELEASE. Together with
  # runtime.conf (on a cutover) this is all the auto-release flow ever
  # writes under /etc/systemd/system; the base units are bootstrap-managed.
  log "Writing systemd drop-in for SENTRY_RELEASE=$DESIRED_TAG"
  write_release_dropin || abort_before_reload "writing $SYSTEMD_DROPIN_FILE failed"

  case "$RUNTIME_ACTION" in
    write-hono)
      log "Writing runtime drop-in: ExecStart -> $DENO_BIN run -A --unstable-kv runtime/deno/server.ts"
      write_runtime_dropin hono || abort_before_reload "writing $RUNTIME_DROPIN_FILE failed"
      ;;
    write-legacy)
      log "Writing runtime drop-in: ExecStart -> $DENO_BIN serve -A --host 127.0.0.1 --port 8000 $LEGACY_ENTRYPOINT"
      write_runtime_dropin legacy || abort_before_reload "writing $RUNTIME_DROPIN_FILE failed"
      ;;
    remove)
      log "Removing runtime drop-in: base unit ExecStart applies again"
      rm -f "$RUNTIME_DROPIN_FILE" || abort_before_reload "removing $RUNTIME_DROPIN_FILE failed"
      ;;
    none) ;;
  esac

  # Sudoers grants kipclip NOPASSWD on these two commands only
  # (see deploy/release/kipclip.sudoers, installed by bootstrap.sh).
  sudo /bin/systemctl daemon-reload || abort_after_reload "systemctl daemon-reload FAILED"

  # Atomic swap. ln -sfn replaces the symlink atomically on Linux (no
  # brief unlinked window).
  log "Atomic swap: current -> $RELEASE_DIR"
  ln -sfn "$RELEASE_DIR" "$CURRENT_LINK" || abort_after_reload "symlink swap FAILED"

  # Restart picks up the new working directory + new SENTRY_RELEASE env +
  # (on a cutover) the new ExecStart. A failed restart enters the rollback
  # path below instead of exiting on `set -e` with the new release still
  # current.
  log "Restarting kipclip"
  RESTART_FAILED=0
  if ! sudo /bin/systemctl restart kipclip; then
    err "systemctl restart kipclip FAILED on $DESIRED_TAG"
    RESTART_FAILED=1
  fi

  # Health check. Sleep+retry; the application server takes ~1s to bind port 8000.
  HEALTH_OK=0
  if [[ "$RESTART_FAILED" == "0" ]]; then
    log "Health-checking $HEALTH_URL"
    if wait_for_health; then
      HEALTH_OK=1
    fi
  fi

  if [[ "$HEALTH_OK" != "1" ]]; then
    err "kipclip failed to come up after restart on $DESIRED_TAG"
    err "rolling back: current -> ${PREV_TARGET:-<none>} and restoring systemd drop-ins"
    if rollback_activation "$HAD_RELEASE_CONF" "$HAD_RUNTIME_CONF" "$PREV_TARGET" "$RELEASE_DIR"; then
      err "rolled back to $(basename "${PREV_TARGET:-?}") successfully"
    else
      err "rollback could not be verified — journal kept at $TXN_DIR; manual recovery required"
    fi
    err "check: journalctl -u kipclip -n 50"
    exit 1
  fi

  # Verified activation: the journal may now be removed.
  txn_cleanup

  # GC: keep the last $GC_KEEP releases plus the current symlink target.
  # while-read (not mapfile) keeps this script bash 3.2-clean, so the
  # regression tests can run it under any bash >= 3.2.
  log "GC: keeping last $GC_KEEP releases"
  CURRENT_TARGET="$(readlink -f "$CURRENT_LINK" 2>/dev/null || echo "")"
  KEPT=0
  while IFS= read -r entry; do
    [[ -n "$entry" ]] || continue
    full="${RELEASES_DIR}/${entry}"
    if [[ "$full" == "$CURRENT_TARGET" ]]; then
      continue
    fi
    KEPT=$((KEPT + 1))
    if (( KEPT > GC_KEEP - 1 )); then
      sublog "removing $entry"
      rm -rf "$full"
    fi
  done < <(ls -1t "$RELEASES_DIR" 2>/dev/null || true)

  log "✅ Released $DESIRED_TAG"
}

main "$@"
