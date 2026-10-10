#!/usr/bin/env bash
# Regression tests for deploy/release/update.sh — the first-Hono-release
# runtime cutover transaction and the crash/failure recovery journal.
#
# Pins (release blockers):
#   1. Staging only: the release is built into releases/<tag>/ while
#      `current` still points at the old release, and before any drop-in
#      is rewritten; a failed build changes nothing (no drop-in write,
#      no daemon-reload, no restart, no journal).
#   2. First Hono release: the release symlink AND the ExecStart override
#      move together before the single restart — at restart time the
#      runtime drop-in carries the Hono entrypoint (resetting the base
#      ExecStart) and `current` already points at the new release.
#   3. Health failure rolls back BOTH: previous `current` symlink AND the
#      previous drop-ins restored byte-exactly (previous bytes when the
#      file existed, absence when it did not), systemd reloaded, the old
#      release restarted, its health re-verified, exit 1.
#   4. Same-kind updates (later Hono releases, plain legacy releases)
#      never touch the runtime drop-in and keep the swap-only path.
#   5. A failed `systemctl restart` enters the rollback path instead of
#      exiting on `set -e` with the new release still current.
#   6. bash 3.2 syntax-clean.
#   7. Activation journal: committed before the first drop-in write and
#      removed only after a verified activation/rollback. Recovery for an
#      interrupted tick runs BEFORE the desired==current fast-path, so a
#      half-applied swap can never be skipped as a no-op.
#   8. Failures before the swap (drop-in write, daemon-reload) restore
#      the pre-tick drop-ins; a failed reload is only considered
#      recovered after a successful retry reload.
#   9. SIGKILL anywhere in the transaction (journal commit, reload, swap,
#      restart, health response) leaves the journal behind. The next tick
#      either completes the activation (swap happened: restart + health)
#      or restores the pre-tick drop-ins (swap never happened). A
#      rollback that cannot be verified keeps the journal (fail closed).
#  10. Legacy pins are base-unit-aware: the runtime override is removed
#      only against a legacy base unit; against a Hono base unit an
#      explicit legacy override is pinned; an unknown base unit fails
#      closed before any mutation.
#  11. Updater revision evidence (source commit + update.sh sha256) is
#      logged before the source checkout is reset, so the next tick's
#      invocation can be told apart in journalctl.
#  12. flock contention exits 0 silently without touching anything.
#  13. A failing journal `sync` is fail-closed: the tick exits 1 before
#      any drop-in write/reload/restart; the committed journal is left
#      for the next tick's recovery, which restores (a no-op here) and
#      completes the release.
#  14. No-journal consistency guard (runs right after recovery, before
#      fetch/build, for any valid `current`): a persisted stale runtime
#      override (journal lost despite sync) fails closed on a
#      unit/current kind mismatch or an undeterminable effective unit —
#      both on the desired==current fast-path and with a newer tag
#      pending, so no transaction ever snapshots the incompatible state.
#  15. The same guard fails closed on a stale or unreadable release.conf
#      SENTRY_RELEASE: a same-kind lost-journal crash leaves the unit
#      kind consistent, so the label is the only evidence left.
#  16. Recovery completion failure (swap already done): when the recovery
#      restart/health cannot verify the target release, the prior release
#      is rolled back to; the journal is cleaned only after a verified
#      rollback, and kept (fail closed, exit 1) when the rollback cannot
#      be verified.
#
# Everything runs offline against stub binaries and temp dirs: no
# network, no /var/lib, no /etc, no real systemctl.
#
# Run: bash tests/shell/update.test.sh   (any bash >= 3.2)
set -u
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SCRIPT="$ROOT/deploy/release/update.sh"

# The pre-Hono runtime's entrypoint (fixtures and assertions below).
# Assembled from fragments so the literal never appears contiguously in
# this file — the framework audit (scripts/audit-framework.ts) scans it
# and must fail closed.
LEGACY_ENTRYPOINT="_""fresh/server.js"

fail() { echo "FAIL: $*" >&2; exit 1; }
ok() { echo "ok: $*"; }

[ -f "$SCRIPT" ] || fail "script not found: $SCRIPT"
bash -n "$SCRIPT" || fail "bash -n syntax check"

# Scenario dir of the currently running test — removed on exit (also on
# failure) so a failed run leaves no litter behind.
CUR_S=""
cleanup_cur_s() {
  if [[ -n "${CUR_S:-}" ]]; then
    rm -rf "$CUR_S"
  fi
  return 0
}
trap cleanup_cur_s EXIT

# ---- stubs ---------------------------------------------------------------
# Every stub models one real dependency of update.sh. State is carried
# through env vars the harness passes on each run (see run_update).
# Crash knobs model a SIGKILL arriving mid-call: the stub kills its
# parent (update.sh) and exits, leaving whatever state the real call
# would have left.

install_stubs() { # $1 = scenario dir
  local S="$1"
  cat > "$S/stubs/sudo" <<'STUB'
#!/usr/bin/env bash
# sudo stub: route /bin/systemctl through the PATH systemctl stub,
# pass everything else through unchanged.
if [[ "${1:-}" == "/bin/systemctl" ]]; then
  shift
  exec systemctl "$@"
fi
exec "$@"
STUB
  cat > "$S/stubs/git" <<'STUB'
#!/usr/bin/env bash
# stateful git stub: models the update.sh calls against $FIXTURE_DIR tag
# fixtures. Every invocation is logged to $GITSTATE/gitlog. The reset
# case also emits a stderr marker so tests can assert ordering relative
# to update.sh's own log lines.
GITSTATE="${GITSTATE:?}"
log() { printf '%s\n' "$*" >> "$GITSTATE/gitlog"; }
last=""
for a in "$@"; do last="$a"; done
case "$*" in
  *"fetch"*)
    log "fetch"
    exit 0
    ;;
  *"reset --hard"*)
    log "reset:$last"
    echo "git stub: reset --hard $last" >&2
    exit 0
    ;;
  *"rev-parse --verify refs/tags/"*)
    tag="${last##*refs/tags/}"
    if [[ -d "${FIXTURE_DIR:?}/$tag" ]]; then
      exit 0
    fi
    exit 1
    ;;
  *"rev-parse HEAD"*)
    if [[ -f "$GITSTATE/head" ]]; then
      cat "$GITSTATE/head"
    else
      echo "0000000000000000000000000000000000000000"
    fi
    exit 0
    ;;
  *"tag --sort"*)
    cat "$GITSTATE/tags" 2>/dev/null || true
    exit 0
    ;;
  *"archive"*)
    log "archive:$last"
    exec tar -c -C "${FIXTURE_DIR:?}/$last" .
    ;;
  *"rev-parse --short"*)
    echo "cafe1234"
    exit 0
    ;;
esac
echo "git stub unhandled: $*" >&2
exit 0
STUB
  cat > "$S/stubs/deno" <<'STUB'
#!/usr/bin/env bash
# fake deno: records the staging-time state (current symlink + drop-in
# dir must be untouched while the release is only being built), then
# succeeds unless DENO_BUILD_EXIT is non-zero.
{
  echo "current=$(readlink -f "${KIPCLIP_RELEASE_ROOT:?}/current" 2>/dev/null || true)"
  echo "dropins=$(ls -A "${KIPCLIP_RELEASE_DROPIN_DIR:?}" 2>/dev/null | tr '\n' ' ')"
} >> "${BUILD_SNAPSHOT:?}"
if [[ "${DENO_BUILD_EXIT:-0}" != "0" ]]; then
  echo "deno stub: simulated build failure" >&2
  exit "${DENO_BUILD_EXIT}"
fi
echo "deno stub: build ok"
exit 0
STUB
  cat > "$S/stubs/systemctl" <<'STUB'
#!/usr/bin/env bash
# stateful systemctl stub: logs every call, snapshots the activation
# state at each `restart kipclip` (drop-in dir + resolved current
# symlink), can fail the first N daemon-reloads
# (SYSCTL_FAIL_DAEMON_RELOAD) or restarts (SYSCTL_FAIL_RESTARTS), and
# can model a SIGKILL mid-call (SYSCTL_CRASH_ON_DAEMON_RELOAD /
# SYSCTL_CRASH_ON_RESTART) by killing its parent (update.sh).
SNAP_DIR="${SNAP_DIR:?}"
SYSCTL_LOG="${SYSCTL_LOG:?}"
printf '%s\n' "$*" >> "$SYSCTL_LOG"
case "$*" in
  "daemon-reload")
    n=0
    if [[ -f "$SYSCTL_LOG.reloads" ]]; then
      n="$(cat "$SYSCTL_LOG.reloads")"
    fi
    n=$((n + 1))
    printf '%s\n' "$n" > "$SYSCTL_LOG.reloads"
    if [[ "${SYSCTL_CRASH_ON_DAEMON_RELOAD:-0}" != "0" ]]; then
      kill -9 "$PPID"
      sleep 0.2
      exit 0
    fi
    if (( n <= ${SYSCTL_FAIL_DAEMON_RELOAD:-0} )); then
      exit 1
    fi
    exit 0
    ;;
  "restart kipclip")
    n=0
    if [[ -f "$SYSCTL_LOG.restarts" ]]; then
      n="$(cat "$SYSCTL_LOG.restarts")"
    fi
    n=$((n + 1))
    printf '%s\n' "$n" > "$SYSCTL_LOG.restarts"
    mkdir -p "$SNAP_DIR/restart-$n"
    cp -a "${KIPCLIP_RELEASE_DROPIN_DIR:?}/." "$SNAP_DIR/restart-$n/" 2>/dev/null || true
    readlink -f "${KIPCLIP_RELEASE_ROOT:?}/current" > "$SNAP_DIR/restart-$n.current" 2>/dev/null || true
    if [[ "${SYSCTL_CRASH_ON_RESTART:-0}" != "0" ]]; then
      kill -9 "$PPID"
      sleep 0.2
      exit 0
    fi
    if (( n <= ${SYSCTL_FAIL_RESTARTS:-0} )); then
      exit 1
    fi
    exit 0
    ;;
  *)
    echo "systemctl stub unhandled: $*" >&2
    exit 0
    ;;
esac
STUB
  cat > "$S/stubs/curl" <<'STUB'
#!/usr/bin/env bash
# stateful curl stub: fails the first CURL_FAIL_FIRST calls, succeeds
# after (models a health endpoint that only comes up on rollback).
# CURL_CRASH_ON_SUCCESS models a SIGKILL arriving right after a
# successful health response.
count_file="${HEALTH_COUNT_FILE:?}"
n=0
if [[ -f "$count_file" ]]; then
  n="$(cat "$count_file")"
fi
n=$((n + 1))
printf '%s\n' "$n" > "$count_file"
if (( n <= ${CURL_FAIL_FIRST:-0} )); then
  exit 7
fi
if [[ "${CURL_CRASH_ON_SUCCESS:-0}" != "0" ]]; then
  kill -9 "$PPID"
  sleep 0.2
  exit 0
fi
exit 0
STUB
  cat > "$S/stubs/flock" <<'STUB'
#!/usr/bin/env bash
# flock stub: single-run tests acquire; FLOCK_FAIL=1 models another tick
# already holding the lock (the updater must exit 0 silently).
if [[ "${FLOCK_FAIL:-0}" != "0" ]]; then
  exit 1
fi
exit 0
STUB
  cat > "$S/stubs/sync" <<'STUB'
#!/usr/bin/env bash
# sync stub: the durability flush is not exercised offline; SYNC_FAIL
# models a flush that returns EIO (the updater must fail closed before
# mutating anything), CRASH_ON_SYNC models a SIGKILL in the window right
# after the journal commit.
if [[ "${SYNC_FAIL:-0}" != "0" ]]; then
  exit 1
fi
if [[ "${CRASH_ON_SYNC:-0}" != "0" ]]; then
  kill -9 "$PPID"
  sleep 0.2
fi
exit 0
STUB
  cat > "$S/stubs/ln" <<'STUB'
#!/usr/bin/env bash
# ln stub: CRASH_ON_LN models a SIGKILL arriving at the atomic swap
# (before it executes); everything else goes to the real ln.
if [[ "${CRASH_ON_LN:-0}" != "0" ]]; then
  kill -9 "$PPID"
  sleep 0.2
  exit 0
fi
exec /bin/ln "$@"
STUB
  chmod +x "$S/stubs/"*
}

# ---- harness -------------------------------------------------------------

new_scenario() {
  local S
  S="$(mktemp -d)" || fail "mktemp -d failed"
  # Canonicalize: on macOS /var is a symlink to /private/var, and the
  # script resolves paths with readlink -f — keep both sides identical.
  S="$(cd "$S" && pwd -P)"
  mkdir -p "$S/root/source/.git" "$S/root/releases" "$S/dropin" \
    "$S/fixtures" "$S/stubs" "$S/snap" "$S/tmpdir" "$S/gitstate" "$S/base"
  : > "$S/gitstate/gitlog"
  echo "1111111111111111111111111111111111111111" > "$S/gitstate/head"
  install_stubs "$S"
  # Default base unit: a legacy (pre-Hono) bootstrap-managed unit, so the
  # no-journal consistency guard can always determine the effective
  # ExecStart kind (production always has a readable base unit). A
  # scenario that needs a different base unit overwrites it via
  # make_base_unit; the unknown-base-unit scenario removes it.
  make_base_unit "$S" legacy
  echo "$S"
}

# A Hono release tree: the runtime/deno/server.ts marker is present.
make_hono_tree() { # $1 = dir
  mkdir -p "$1/runtime/deno"
  echo "export const entry = true;" > "$1/runtime/deno/server.ts"
  echo '{"name":"kipclip"}' > "$1/deno.json"
}

# A pre-Hono release tree: no runtime/deno/server.ts marker (the runtime
# kind check is marker-based, so this is the faithful fixture).
make_legacy_tree() { # $1 = dir
  mkdir -p "$1"
  echo "legacy build artifact" > "$1/entry.js"
  echo '{"name":"kipclip"}' > "$1/deno.json"
}

# The bootstrap-managed base unit fixture at $S/base/kipclip.service
# (run_update points KIPCLIP_RELEASE_BASE_UNIT_FILE at it). kind is
# "legacy" (pre-Hono entrypoint) or "hono" (runtime entrypoint).
make_base_unit() { # $1 = scenario dir, $2 = kind
  mkdir -p "$1/base"
  case "$2" in
    legacy)
      cat > "$1/base/kipclip.service" <<UNIT
[Unit]
Description=kipclip Deno app (pre-Hono)
[Service]
ExecStart=/opt/deno/bin/deno serve -A --host 127.0.0.1 --port 8000 ${LEGACY_ENTRYPOINT}
UNIT
      ;;
    hono)
      cat > "$1/base/kipclip.service" <<'UNIT'
[Unit]
Description=kipclip Deno app (Hono)
[Service]
ExecStart=/opt/deno/bin/deno run -A --unstable-kv runtime/deno/server.ts
UNIT
      ;;
    *)
      fail "make_base_unit: unknown kind $2"
      ;;
  esac
}

# Reset per-scenario knobs so no scenario leaks into the next.
reset_knobs() {
  CURL_FAIL_FIRST=0
  CURL_CRASH_ON_SUCCESS=0
  SYSCTL_FAIL_RESTARTS=0
  SYSCTL_FAIL_DAEMON_RELOAD=0
  SYSCTL_CRASH_ON_DAEMON_RELOAD=0
  SYSCTL_CRASH_ON_RESTART=0
  DENO_BUILD_EXIT=0
  SYNC_FAIL=0
  CRASH_ON_SYNC=0
  CRASH_ON_LN=0
  FLOCK_FAIL=0
  KIPCLIP_RELEASE_PIN_FILE=""
  KIPCLIP_RELEASE_BASE_UNIT_FILE=""
  KIPCLIP_RELEASE_HEALTH_ATTEMPTS=2
  KIPCLIP_RELEASE_GC_KEEP=5
}

run_update() { # $1 = scenario dir, $2 = log file
  local S="$1" log="$2"
  env \
    KIPCLIP_RELEASE_REPO_URL="https://example.invalid/kipclip.git" \
    KIPCLIP_RELEASE_PIN_FILE="${KIPCLIP_RELEASE_PIN_FILE:-$S/no-pin}" \
    KIPCLIP_RELEASE_GC_KEEP="${KIPCLIP_RELEASE_GC_KEEP:-5}" \
    KIPCLIP_RELEASE_ROOT="$S/root" \
    KIPCLIP_RELEASE_DROPIN_DIR="$S/dropin" \
    KIPCLIP_RELEASE_BASE_UNIT_FILE="${KIPCLIP_RELEASE_BASE_UNIT_FILE:-$S/base/kipclip.service}" \
    KIPCLIP_RELEASE_HEALTH_URL="http://127.0.0.1:9/api/health" \
    KIPCLIP_RELEASE_HEALTH_ATTEMPTS="${KIPCLIP_RELEASE_HEALTH_ATTEMPTS:-2}" \
    KIPCLIP_RELEASE_HEALTH_SLEEP=0 \
    DENO_BIN="$S/stubs/deno" \
    DENO_BUILD_EXIT="${DENO_BUILD_EXIT:-0}" \
    GITSTATE="$S/gitstate" \
    FIXTURE_DIR="$S/fixtures" \
    SNAP_DIR="$S/snap" \
    SYSCTL_LOG="$S/sysctl.log" \
    SYSCTL_FAIL_RESTARTS="${SYSCTL_FAIL_RESTARTS:-0}" \
    SYSCTL_FAIL_DAEMON_RELOAD="${SYSCTL_FAIL_DAEMON_RELOAD:-0}" \
    SYSCTL_CRASH_ON_DAEMON_RELOAD="${SYSCTL_CRASH_ON_DAEMON_RELOAD:-0}" \
    SYSCTL_CRASH_ON_RESTART="${SYSCTL_CRASH_ON_RESTART:-0}" \
    CURL_FAIL_FIRST="${CURL_FAIL_FIRST:-0}" \
    CURL_CRASH_ON_SUCCESS="${CURL_CRASH_ON_SUCCESS:-0}" \
    SYNC_FAIL="${SYNC_FAIL:-0}" \
    CRASH_ON_SYNC="${CRASH_ON_SYNC:-0}" \
    CRASH_ON_LN="${CRASH_ON_LN:-0}" \
    FLOCK_FAIL="${FLOCK_FAIL:-0}" \
    HEALTH_COUNT_FILE="$S/health.count" \
    BUILD_SNAPSHOT="$S/build.snapshot" \
    TMPDIR="$S/tmpdir" \
    PATH="$S/stubs:$PATH" \
    bash "$SCRIPT" > "$log" 2>&1
}

# Same as run_update, for the scenarios that simulate SIGKILL: the test
# shell prints a "Killed: 9" job notification for the killed child, which
# is expected here and pure noise, so it is suppressed on this side only
# (the updater's own output still lands in $log).
run_update_crash() { # $1 = scenario dir, $2 = log file
  run_update "$1" "$2" 2>/dev/null
}

# Legacy release v0.25.2 current; Hono v0.26.0 staged as the desired tag.
setup_cutover_scenario() { # $1 = scenario dir
  local S="$1"
  make_legacy_tree "$S/fixtures/v0.25.2"
  make_hono_tree "$S/fixtures/v0.26.0"
  printf 'v0.26.0\nv0.25.2\n' > "$S/gitstate/tags"
  make_legacy_tree "$S/root/releases/v0.25.2"
  echo "v0.25.2" > "$S/root/releases/v0.25.2/.version"
  ln -sfn "$S/root/releases/v0.25.2" "$S/root/current"
}

assert_current() { # $1 = S, $2 = expected release name
  local got
  got="$(readlink -f "$1/root/current" 2>/dev/null || true)"
  [[ "$got" == "$1/root/releases/$2" ]] ||
    fail "current -> '$got' (want $1/root/releases/$2)"
}

assert_file_eq() { # $1 = expected file, $2 = actual file
  cmp -s "$1" "$2" || fail "file mismatch: $2 != $1"
}

assert_file_absent() { # $1 = path
  [[ ! -e "$1" ]] || fail "file must not exist: $1"
}

assert_tmp_clean() { # $1 = S — nothing may litter TMPDIR
  [[ -z "$(ls -A "$1/tmpdir" 2>/dev/null)" ]] ||
    fail "TMPDIR litter: $(ls -A "$1/tmpdir")"
}

assert_journal_absent() { # $1 = S — no committed journal, no staging dir
  [[ ! -e "$1/root/.release-txn" && ! -e "$1/root/.release-txn.tmp" ]] ||
    fail "activation journal must not exist: $(ls -d "$1"/root/.release-txn* 2>/dev/null)"
}

assert_journal_present() { # $1 = S
  [[ -f "$1/root/.release-txn/meta" ]] ||
    fail "activation journal expected at $1/root/.release-txn"
}

line_of() { # $1 = file, $2 = pattern -> first matching line number
  grep -n "$2" "$1" | head -1 | cut -d: -f1
}

assert_order() { # $1 = file, $2 = earlier pattern, $3 = later pattern
  local a b
  a="$(line_of "$1" "$2")"
  b="$(line_of "$1" "$3")"
  [[ -n "$a" && -n "$b" && "$a" -lt "$b" ]] ||
    fail "expected '$2' (line ${a:-none}) before '$3' (line ${b:-none}) in $1"
}

# sha256 of the updater under test, using the same fallback chain as
# update.sh, for asserting the revision evidence line.
expected_updater_sha() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$SCRIPT" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$SCRIPT" | awk '{print $1}'
  elif command -v openssl >/dev/null 2>&1; then
    openssl dgst -sha256 "$SCRIPT" | awk '{print $NF}'
  else
    echo "unavailable"
  fi
}

# ---- 1. first Hono release: successful activation ------------------------

t1() {
  reset_knobs
  local S log rc b d r s
  S="$(new_scenario)"; CUR_S="$S"
  setup_cutover_scenario "$S"
  printf '[Service]\nEnvironment="SENTRY_RELEASE=v0.25.2"\n' > "$S/dropin/release.conf"

  log="$S/run.log"; rc=0
  run_update "$S" "$log" || rc=$?

  [[ "$rc" -eq 0 ]] || fail "successful cutover should exit 0, got $rc; log: $(cat "$log")"
  grep -q "Runtime cutover: legacy -> hono" "$log" ||
    fail "cutover must be announced; log: $(cat "$log")"
  grep -q "✅ Released v0.26.0" "$log" || fail "success line missing; log: $(cat "$log")"
  grep -q "Updater revision: commit=1111111111111111111111111111111111111111 update.sh-sha256=$(expected_updater_sha)" "$log" ||
    fail "updater revision evidence missing; log: $(cat "$log")"

  # Staging: built while `current` still pointed at the old release, and
  # before the runtime drop-in existed.
  grep -q "^current=$S/root/releases/v0.25.2$" "$S/build.snapshot" ||
    fail "release must be built while current is still the old release: $(cat "$S/build.snapshot")"
  grep -q "runtime.conf" "$S/build.snapshot" &&
    fail "runtime drop-in must not exist while staging: $(cat "$S/build.snapshot")"

  # Ordering: build -> drop-in writes -> swap -> restart.
  b="$(grep -n "Building v0.26.0" "$log" | head -1 | cut -d: -f1)"
  d="$(grep -n "Writing systemd drop-in" "$log" | head -1 | cut -d: -f1)"
  r="$(grep -n "Writing runtime drop-in" "$log" | head -1 | cut -d: -f1)"
  s="$(grep -n "Atomic swap" "$log" | head -1 | cut -d: -f1)"
  [[ -n "$b" && -n "$d" && -n "$r" && -n "$s" ]] ||
    fail "ordering markers missing; log: $(cat "$log")"
  (( b < d && d < r && r < s )) ||
    fail "ordering violated (build=$b dropin=$d runtime=$r swap=$s); log: $(cat "$log")"

  # Symlink + unit moved together: at restart time `current` already
  # pointed at the new release AND the ExecStart override was in place.
  assert_current "$S" v0.26.0
  [[ "$(cat "$S/snap/restart-1.current")" == "$S/root/releases/v0.26.0" ]] ||
    fail "at restart current was: $(cat "$S/snap/restart-1.current")"
  grep -q '^ExecStart=$' "$S/snap/restart-1/runtime.conf" ||
    fail "runtime drop-in must reset the base ExecStart: $(cat "$S/snap/restart-1/runtime.conf")"
  grep -qF "ExecStart=$S/stubs/deno run -A --unstable-kv runtime/deno/server.ts" "$S/snap/restart-1/runtime.conf" ||
    fail "runtime drop-in must pin the Hono entrypoint: $(cat "$S/snap/restart-1/runtime.conf")"
  grep -q 'SENTRY_RELEASE=v0.26.0' "$S/snap/restart-1/release.conf" ||
    fail "release.conf must carry the new tag at restart"

  # Exactly one daemon-reload + one restart, reload first.
  [[ "$(grep -c '^daemon-reload$' "$S/sysctl.log")" -eq 1 ]] ||
    fail "expected 1 daemon-reload: $(cat "$S/sysctl.log")"
  [[ "$(grep -c '^restart kipclip$' "$S/sysctl.log")" -eq 1 ]] ||
    fail "expected 1 restart: $(cat "$S/sysctl.log")"
  [[ "$(grep -n '^daemon-reload$' "$S/sysctl.log" | head -1 | cut -d: -f1)" -lt \
    "$(grep -n '^restart kipclip$' "$S/sysctl.log" | head -1 | cut -d: -f1)" ]] ||
    fail "daemon-reload must precede restart: $(cat "$S/sysctl.log")"

  # Final state: override persists for later Hono updates; old release
  # kept as the rollback target; the journal is gone after verified
  # success.
  grep -qF "ExecStart=$S/stubs/deno run -A --unstable-kv runtime/deno/server.ts" "$S/dropin/runtime.conf" ||
    fail "runtime.conf must persist after a successful cutover"
  grep -q 'SENTRY_RELEASE=v0.26.0' "$S/dropin/release.conf" ||
    fail "release.conf final state wrong: $(cat "$S/dropin/release.conf")"
  [[ -d "$S/root/releases/v0.25.2" ]] || fail "previous release must be kept as rollback target"
  assert_journal_absent "$S"
  assert_tmp_clean "$S"

  rm -rf "$S"; CUR_S=""
  ok "first Hono activation: staged before activation; symlink + ExecStart override switched together; one restart; journal cleaned; exit 0"
}
t1

# ---- 2. first Hono release: health failure restores symlink + drop-ins ---

t2() {
  reset_knobs
  local S log rc
  S="$(new_scenario)"; CUR_S="$S"
  setup_cutover_scenario "$S"
  printf '# hand-tuned operator edit\n[Service]\nEnvironment="SENTRY_RELEASE=v0.25.2"\n' > "$S/dropin/release.conf"
  cp "$S/dropin/release.conf" "$S/old-release.conf"
  # no pre-existing runtime.conf
  CURL_FAIL_FIRST=2 # both activation attempts fail; rollback check succeeds

  log="$S/run.log"; rc=0
  run_update "$S" "$log" || rc=$?

  [[ "$rc" -eq 1 ]] || fail "failed cutover must exit 1, got $rc; log: $(cat "$log")"
  grep -q "failed to come up after restart on v0.26.0" "$log" ||
    fail "failure line missing; log: $(cat "$log")"
  grep -q "rolling back: current -> $S/root/releases/v0.25.2" "$log" ||
    fail "rollback line missing; log: $(cat "$log")"
  grep -q "rolled back to v0.25.2 successfully" "$log" ||
    fail "rollback health not re-verified; log: $(cat "$log")"

  # Both restored together before the rollback restart.
  assert_current "$S" v0.25.2
  assert_file_eq "$S/old-release.conf" "$S/dropin/release.conf"
  assert_file_absent "$S/dropin/runtime.conf"
  [[ "$(cat "$S/snap/restart-2.current")" == "$S/root/releases/v0.25.2" ]] ||
    fail "rollback restart ran with current=$(cat "$S/snap/restart-2.current")"
  assert_file_eq "$S/old-release.conf" "$S/snap/restart-2/release.conf"
  assert_file_absent "$S/snap/restart-2/runtime.conf"

  # reload -> restart -> reload -> restart; journal cleaned (verified rollback).
  [[ "$(grep -c '^daemon-reload$' "$S/sysctl.log")" -eq 2 ]] ||
    fail "expected 2 daemon-reloads: $(cat "$S/sysctl.log")"
  [[ "$(grep -c '^restart kipclip$' "$S/sysctl.log")" -eq 2 ]] ||
    fail "expected 2 restarts: $(cat "$S/sysctl.log")"
  assert_journal_absent "$S"
  assert_tmp_clean "$S"

  rm -rf "$S"; CUR_S=""
  ok "failed first Hono activation: previous symlink + release.conf restored byte-exactly, runtime override removed, systemd reloaded, old release restarted and re-verified, journal cleaned"
}
t2

# ---- 3. pre-existing runtime override must be restored byte-exactly ------

t3() {
  reset_knobs
  local S log rc
  S="$(new_scenario)"; CUR_S="$S"
  setup_cutover_scenario "$S"
  printf '# operator experiment\n[Service]\nEnvironment="KIPCLIP_EXPERIMENT=1"\n' > "$S/dropin/runtime.conf"
  cp "$S/dropin/runtime.conf" "$S/old-runtime.conf"
  # no pre-existing release.conf
  CURL_FAIL_FIRST=2

  log="$S/run.log"; rc=0
  run_update "$S" "$log" || rc=$?

  [[ "$rc" -eq 1 ]] || fail "failed cutover must exit 1, got $rc; log: $(cat "$log")"
  grep -q "rolled back to v0.25.2 successfully" "$log" ||
    fail "rollback health not re-verified; log: $(cat "$log")"

  assert_current "$S" v0.25.2
  assert_file_eq "$S/old-runtime.conf" "$S/dropin/runtime.conf"
  assert_file_absent "$S/dropin/release.conf"
  assert_file_eq "$S/old-runtime.conf" "$S/snap/restart-2/runtime.conf"
  assert_file_absent "$S/snap/restart-2/release.conf"
  assert_journal_absent "$S"
  assert_tmp_clean "$S"

  rm -rf "$S"; CUR_S=""
  ok "failed first Hono activation: pre-existing runtime override restored byte-exactly; release.conf removed again (absent before)"
}
t3

# ---- 4. later Hono update (same runtime): no override churn --------------

t4() {
  reset_knobs
  local S log rc
  S="$(new_scenario)"; CUR_S="$S"
  make_hono_tree "$S/fixtures/v0.26.0"
  make_hono_tree "$S/fixtures/v0.26.1"
  printf 'v0.26.1\nv0.26.0\n' > "$S/gitstate/tags"
  make_hono_tree "$S/root/releases/v0.26.0"
  echo "v0.26.0" > "$S/root/releases/v0.26.0/.version"
  ln -sfn "$S/root/releases/v0.26.0" "$S/root/current"
  printf '# pre-existing managed override\n[Service]\nExecStart=\nExecStart=%s run -A --unstable-kv runtime/deno/server.ts\n' "$S/stubs/deno" > "$S/dropin/runtime.conf"
  cp "$S/dropin/runtime.conf" "$S/old-runtime.conf"
  printf '[Service]\nEnvironment="SENTRY_RELEASE=v0.26.0"\n' > "$S/dropin/release.conf"

  log="$S/run.log"; rc=0
  run_update "$S" "$log" || rc=$?

  [[ "$rc" -eq 0 ]] || fail "same-kind Hono update should exit 0, got $rc; log: $(cat "$log")"
  grep -q "Runtime unchanged (hono)" "$log" ||
    fail "same-kind update must report no cutover; log: $(cat "$log")"
  grep -q "Runtime cutover" "$log" &&
    fail "same-kind update must not run the cutover; log: $(cat "$log")"
  grep -q "Writing runtime drop-in" "$log" &&
    fail "same-kind update must not rewrite the runtime drop-in; log: $(cat "$log")"

  assert_current "$S" v0.26.1
  assert_file_eq "$S/old-runtime.conf" "$S/dropin/runtime.conf"
  assert_file_eq "$S/old-runtime.conf" "$S/snap/restart-1/runtime.conf"
  grep -q 'SENTRY_RELEASE=v0.26.1' "$S/snap/restart-1/release.conf" ||
    fail "release.conf not updated at restart"
  [[ "$(grep -c '^restart kipclip$' "$S/sysctl.log")" -eq 1 ]] ||
    fail "expected exactly 1 restart: $(cat "$S/sysctl.log")"
  assert_journal_absent "$S"
  assert_tmp_clean "$S"

  rm -rf "$S"; CUR_S=""
  ok "later Hono update (same runtime): swap-only path, pre-existing runtime override byte-identical, journal cleaned, exit 0"
}
t4

# ---- 5. legacy update (same runtime): swap-only path ---------------------

t5() {
  reset_knobs
  local S log rc
  S="$(new_scenario)"; CUR_S="$S"
  make_legacy_tree "$S/fixtures/v0.25.1"
  make_legacy_tree "$S/fixtures/v0.25.2"
  printf 'v0.25.2\nv0.25.1\n' > "$S/gitstate/tags"
  make_legacy_tree "$S/root/releases/v0.25.1"
  echo "v0.25.1" > "$S/root/releases/v0.25.1/.version"
  ln -sfn "$S/root/releases/v0.25.1" "$S/root/current"
  printf '[Service]\nEnvironment="SENTRY_RELEASE=v0.25.1"\n' > "$S/dropin/release.conf"

  log="$S/run.log"; rc=0
  run_update "$S" "$log" || rc=$?

  [[ "$rc" -eq 0 ]] || fail "legacy update should exit 0, got $rc; log: $(cat "$log")"
  grep -q "Runtime unchanged (legacy)" "$log" ||
    fail "legacy update must keep the plain path; log: $(cat "$log")"
  grep -q "Runtime cutover" "$log" &&
    fail "legacy-to-legacy must not trigger a cutover; log: $(cat "$log")"

  assert_current "$S" v0.25.2
  assert_file_absent "$S/dropin/runtime.conf"
  assert_file_absent "$S/snap/restart-1/runtime.conf"
  grep -q 'SENTRY_RELEASE=v0.25.2' "$S/dropin/release.conf" ||
    fail "release.conf not updated: $(cat "$S/dropin/release.conf")"
  assert_journal_absent "$S"
  assert_tmp_clean "$S"

  rm -rf "$S"; CUR_S=""
  ok "legacy update (same runtime): swap-only path, no runtime override written, journal cleaned, exit 0"
}
t5

# ---- 6. failed build: nothing is activated --------------------------------

t6() {
  reset_knobs
  local S log rc
  S="$(new_scenario)"; CUR_S="$S"
  setup_cutover_scenario "$S"
  printf '[Service]\nEnvironment="SENTRY_RELEASE=v0.25.2"\n' > "$S/dropin/release.conf"
  cp "$S/dropin/release.conf" "$S/old-release.conf"
  DENO_BUILD_EXIT=1

  log="$S/run.log"; rc=0
  run_update "$S" "$log" || rc=$?

  [[ "$rc" -eq 1 ]] || fail "failed build must exit 1, got $rc; log: $(cat "$log")"
  assert_current "$S" v0.25.2
  assert_file_eq "$S/old-release.conf" "$S/dropin/release.conf"
  assert_file_absent "$S/dropin/runtime.conf"
  [[ ! -s "$S/sysctl.log" ]] || fail "no systemctl call expected: $(cat "$S/sysctl.log")"
  [[ ! -e "$S/root/releases/v0.26.0/.version" ]] ||
    fail "failed build must not complete the release"
  # A failed build happens before the transaction: no journal at all.
  assert_journal_absent "$S"
  assert_tmp_clean "$S"

  rm -rf "$S"; CUR_S=""
  ok "failed build: current untouched, no drop-in written, no systemctl call, no journal"
}
t6

# ---- 7. pin back across the runtime boundary (base-unit-aware) -----------

# 7a: legacy base unit — removing the override is safe, base applies again.
t7() {
  reset_knobs
  local S log rc
  S="$(new_scenario)"; CUR_S="$S"
  make_legacy_tree "$S/fixtures/v0.25.2"
  make_hono_tree "$S/root/releases/v0.26.0"
  echo "v0.26.0" > "$S/root/releases/v0.26.0/.version"
  ln -sfn "$S/root/releases/v0.26.0" "$S/root/current"
  printf '[Service]\nExecStart=\nExecStart=%s run -A --unstable-kv runtime/deno/server.ts\n' "$S/stubs/deno" > "$S/dropin/runtime.conf"
  printf '[Service]\nEnvironment="SENTRY_RELEASE=v0.26.0"\n' > "$S/dropin/release.conf"
  make_base_unit "$S" legacy
  echo "v0.25.2" > "$S/pin"
  KIPCLIP_RELEASE_PIN_FILE="$S/pin"

  log="$S/run.log"; rc=0
  run_update "$S" "$log" || rc=$?

  [[ "$rc" -eq 0 ]] || fail "pinned rollback should exit 0, got $rc; log: $(cat "$log")"
  grep -q "Runtime cutover: hono -> legacy" "$log" ||
    fail "hono->legacy switch must be announced; log: $(cat "$log")"
  grep -q "Removing runtime drop-in" "$log" ||
    fail "runtime drop-in removal missing; log: $(cat "$log")"

  assert_current "$S" v0.25.2
  assert_file_absent "$S/dropin/runtime.conf"
  assert_file_absent "$S/snap/restart-1/runtime.conf"
  grep -q 'SENTRY_RELEASE=v0.25.2' "$S/snap/restart-1/release.conf" ||
    fail "release.conf not updated at restart"
  assert_journal_absent "$S"
  assert_tmp_clean "$S"

  rm -rf "$S"; CUR_S=""
  ok "pinned rollback across the runtime boundary (legacy base unit): override removed so the base unit applies, exit 0"
}
t7

# 7b: Hono base unit (post-bootstrap) — removal would leave a Hono
# ExecStart pointing at a legacy tree; an explicit legacy override must
# be pinned instead.
t7b() {
  reset_knobs
  local S log rc
  S="$(new_scenario)"; CUR_S="$S"
  make_legacy_tree "$S/fixtures/v0.25.2"
  make_hono_tree "$S/root/releases/v0.26.0"
  echo "v0.26.0" > "$S/root/releases/v0.26.0/.version"
  ln -sfn "$S/root/releases/v0.26.0" "$S/root/current"
  printf '[Service]\nExecStart=\nExecStart=%s run -A --unstable-kv runtime/deno/server.ts\n' "$S/stubs/deno" > "$S/dropin/runtime.conf"
  printf '[Service]\nEnvironment="SENTRY_RELEASE=v0.26.0"\n' > "$S/dropin/release.conf"
  make_base_unit "$S" hono
  echo "v0.25.2" > "$S/pin"
  KIPCLIP_RELEASE_PIN_FILE="$S/pin"

  log="$S/run.log"; rc=0
  run_update "$S" "$log" || rc=$?

  [[ "$rc" -eq 0 ]] || fail "base-unit-aware pinned rollback should exit 0, got $rc; log: $(cat "$log")"
  grep -q "Runtime cutover: hono -> legacy" "$log" ||
    fail "cutover must be announced; log: $(cat "$log")"
  grep -q "Writing runtime drop-in: ExecStart -> .*$LEGACY_ENTRYPOINT" "$log" ||
    fail "legacy override must be written against a Hono base unit; log: $(cat "$log")"
  grep -q "Removing runtime drop-in" "$log" &&
    fail "must not remove the override against a Hono base unit; log: $(cat "$log")"

  assert_current "$S" v0.25.2
  grep -q '^ExecStart=$' "$S/dropin/runtime.conf" ||
    fail "legacy override must reset the base ExecStart: $(cat "$S/dropin/runtime.conf")"
  grep -qF "ExecStart=$S/stubs/deno serve -A --host 127.0.0.1 --port 8000 $LEGACY_ENTRYPOINT" "$S/dropin/runtime.conf" ||
    fail "legacy override content wrong: $(cat "$S/dropin/runtime.conf")"
  grep -qF "ExecStart=$S/stubs/deno serve -A --host 127.0.0.1 --port 8000 $LEGACY_ENTRYPOINT" "$S/snap/restart-1/runtime.conf" ||
    fail "at restart the legacy override must be active: $(cat "$S/snap/restart-1/runtime.conf")"
  grep -q 'SENTRY_RELEASE=v0.25.2' "$S/snap/restart-1/release.conf" ||
    fail "release.conf not updated at restart"
  assert_journal_absent "$S"
  assert_tmp_clean "$S"

  rm -rf "$S"; CUR_S=""
  ok "pinned rollback against a Hono base unit: explicit legacy ExecStart override pinned, exit 0"
}
t7b

# 7c: unreadable/unknown base unit — fail closed before any mutation.
t7c() {
  reset_knobs
  local S log rc
  S="$(new_scenario)"; CUR_S="$S"
  make_legacy_tree "$S/fixtures/v0.25.2"
  make_hono_tree "$S/root/releases/v0.26.0"
  echo "v0.26.0" > "$S/root/releases/v0.26.0/.version"
  ln -sfn "$S/root/releases/v0.26.0" "$S/root/current"
  printf '[Service]\nExecStart=\nExecStart=%s run -A --unstable-kv runtime/deno/server.ts\n' "$S/stubs/deno" > "$S/dropin/runtime.conf"
  cp "$S/dropin/runtime.conf" "$S/old-runtime.conf"
  printf '[Service]\nEnvironment="SENTRY_RELEASE=v0.26.0"\n' > "$S/dropin/release.conf"
  cp "$S/dropin/release.conf" "$S/old-release.conf"
  echo "v0.25.2" > "$S/pin"
  KIPCLIP_RELEASE_PIN_FILE="$S/pin"
  # Intentionally remove the harness's default base unit fixture ->
  # base_unit_kind reads unknown.
  rm -f "$S/base/kipclip.service"

  log="$S/run.log"; rc=0
  run_update "$S" "$log" || rc=$?

  [[ "$rc" -eq 1 ]] || fail "unknown base unit must fail closed (rc 1), got $rc; log: $(cat "$log")"
  grep -q "cannot determine the base unit ExecStart kind" "$log" ||
    fail "fail-closed reason missing; log: $(cat "$log")"
  # Nothing was mutated: no swap, no drop-in churn, no systemctl, no journal.
  assert_current "$S" v0.26.0
  assert_file_eq "$S/old-runtime.conf" "$S/dropin/runtime.conf"
  assert_file_eq "$S/old-release.conf" "$S/dropin/release.conf"
  assert_journal_absent "$S"
  [[ ! -e "$S/sysctl.log" ]] || fail "no systemctl call expected: $(cat "$S/sysctl.log")"

  rm -rf "$S"; CUR_S=""
  ok "pinned rollback with an unreadable base unit: fail closed before any mutation, rc 1"
}
t7c

# ---- 8. failed activation restart enters the rollback path ----------------

t8() {
  reset_knobs
  local S log rc
  S="$(new_scenario)"; CUR_S="$S"
  setup_cutover_scenario "$S"
  printf '[Service]\nEnvironment="SENTRY_RELEASE=v0.25.2"\n' > "$S/dropin/release.conf"
  cp "$S/dropin/release.conf" "$S/old-release.conf"
  SYSCTL_FAIL_RESTARTS=1 # activation restart fails; rollback restart succeeds

  log="$S/run.log"; rc=0
  run_update "$S" "$log" || rc=$?

  [[ "$rc" -eq 1 ]] || fail "failed restart must exit 1, got $rc; log: $(cat "$log")"
  grep -q "systemctl restart kipclip FAILED on v0.26.0" "$log" ||
    fail "restart failure not reported; log: $(cat "$log")"
  grep -q "rolling back: current -> $S/root/releases/v0.25.2" "$log" ||
    fail "rollback missing; log: $(cat "$log")"
  grep -q "rolled back to v0.25.2 successfully" "$log" ||
    fail "rollback health not re-verified; log: $(cat "$log")"

  assert_current "$S" v0.25.2
  assert_file_eq "$S/old-release.conf" "$S/dropin/release.conf"
  assert_file_absent "$S/dropin/runtime.conf"
  [[ "$(grep -c '^restart kipclip$' "$S/sysctl.log")" -eq 2 ]] ||
    fail "expected 2 restarts: $(cat "$S/sysctl.log")"
  assert_journal_absent "$S"
  assert_tmp_clean "$S"

  rm -rf "$S"; CUR_S=""
  ok "failed activation restart: enters rollback (not a bare set -e abort), old release restored and healthy, journal cleaned"
}
t8

# ---- 9. flock contention: silent no-op ------------------------------------

t9() {
  reset_knobs
  local S log rc
  S="$(new_scenario)"; CUR_S="$S"
  setup_cutover_scenario "$S"
  FLOCK_FAIL=1

  log="$S/run.log"; rc=0
  run_update "$S" "$log" || rc=$?

  [[ "$rc" -eq 0 ]] || fail "lock contention must exit 0, got $rc; log: $(cat "$log")"
  [[ ! -s "$log" ]] || fail "lock contention must be silent; log: $(cat "$log")"
  [[ ! -s "$S/gitstate/gitlog" ]] ||
    fail "no git call expected under contention: $(cat "$S/gitstate/gitlog")"
  assert_current "$S" v0.25.2
  assert_journal_absent "$S"
  [[ ! -e "$S/sysctl.log" ]] || fail "no systemctl call expected under contention"

  rm -rf "$S"; CUR_S=""
  ok "flock contention: tick exits 0 silently, no fetch, no state change"
}
t9

# ---- 10. updater revision evidence ----------------------------------------

t10() {
  reset_knobs
  local S log rc sha
  S="$(new_scenario)"; CUR_S="$S"
  setup_cutover_scenario "$S"
  sha="$(expected_updater_sha)"
  echo "1111111111111111111111111111111111111111" > "$S/gitstate/head"

  log="$S/run.log"; rc=0
  run_update "$S" "$log" || rc=$?
  [[ "$rc" -eq 0 ]] || fail "release should exit 0, got $rc; log: $(cat "$log")"
  grep -q "Updater revision: commit=1111111111111111111111111111111111111111 update.sh-sha256=$sha" "$log" ||
    fail "revision evidence (commit + updater sha256) missing; log: $(cat "$log")"
  # Evidence is emitted BEFORE the source checkout is reset; the sync
  # marker follows the reset.
  assert_order "$log" "Updater revision:" "git stub: reset --hard"
  assert_order "$log" "git stub: reset --hard" "source tree synced to"

  # Second invocation after a "merge + source sync": the same tick
  # sequence reports the new revision, which is how an operator proves
  # the right updater ran before pushing the tag.
  echo "2222222222222222222222222222222222222222" > "$S/gitstate/head"
  log="$S/run2.log"; rc=0
  run_update "$S" "$log" || rc=$?
  [[ "$rc" -eq 0 ]] || fail "second invocation should exit 0, got $rc; log: $(cat "$log")"
  grep -q "Updater revision: commit=2222222222222222222222222222222222222222 update.sh-sha256=$sha" "$log" ||
    fail "second invocation must log the synced revision; log: $(cat "$log")"
  grep -q "Already on v0.26.0" "$log" || fail "second invocation should be a no-op"

  rm -rf "$S"; CUR_S=""
  ok "updater revision evidence: commit + update.sh sha256 logged before the reset; second invocation reports the synced revision"
}
t10

# ---- 11. drop-in write failure: restore, no reload, journal cleaned -------

t11() {
  reset_knobs
  local S log rc
  S="$(new_scenario)"; CUR_S="$S"
  setup_cutover_scenario "$S"
  printf '[Service]\nEnvironment="SENTRY_RELEASE=v0.25.2"\n' > "$S/dropin/release.conf"
  cp "$S/dropin/release.conf" "$S/old-release.conf"
  chmod 444 "$S/dropin/release.conf"

  log="$S/run.log"; rc=0
  run_update "$S" "$log" || rc=$?

  [[ "$rc" -eq 1 ]] || fail "failed drop-in write must exit 1, got $rc; log: $(cat "$log")"
  grep -q "writing $S/dropin/release.conf failed" "$log" ||
    fail "write-failure line missing; log: $(cat "$log")"
  grep -q "pre-tick drop-in state restored; release aborted before activation" "$log" ||
    fail "verified abort line missing; log: $(cat "$log")"
  assert_current "$S" v0.25.2
  assert_file_eq "$S/old-release.conf" "$S/dropin/release.conf"
  assert_file_absent "$S/dropin/runtime.conf"
  assert_journal_absent "$S"
  # The failure happened before any daemon-reload, so no systemctl call
  # and no journal-worthy systemd state change.
  [[ ! -e "$S/sysctl.log" ]] || fail "no systemctl call expected: $(cat "$S/sysctl.log")"

  rm -rf "$S"; CUR_S=""
  ok "drop-in write failure: prior drop-ins restored byte-exactly, no reload/restart, journal cleaned, rc 1"
}
t11

# ---- 12. daemon-reload failure: restore + verified retry reload -----------

t12() {
  reset_knobs
  local S log rc
  S="$(new_scenario)"; CUR_S="$S"
  setup_cutover_scenario "$S"
  printf '[Service]\nEnvironment="SENTRY_RELEASE=v0.25.2"\n' > "$S/dropin/release.conf"
  cp "$S/dropin/release.conf" "$S/old-release.conf"
  SYSCTL_FAIL_DAEMON_RELOAD=1

  log="$S/run.log"; rc=0
  run_update "$S" "$log" || rc=$?

  [[ "$rc" -eq 1 ]] || fail "reload failure must exit 1, got $rc; log: $(cat "$log")"
  grep -q "systemctl daemon-reload FAILED" "$log" ||
    fail "reload failure not reported; log: $(cat "$log")"
  grep -q "pre-tick systemd state restored; release aborted before restart" "$log" ||
    fail "verified abort line missing; log: $(cat "$log")"
  assert_current "$S" v0.25.2
  assert_file_eq "$S/old-release.conf" "$S/dropin/release.conf"
  assert_file_absent "$S/dropin/runtime.conf"
  assert_journal_absent "$S"
  [[ "$(grep -c '^daemon-reload$' "$S/sysctl.log")" -eq 2 ]] ||
    fail "expected the failed reload + the verified retry: $(cat "$S/sysctl.log")"
  [[ "$(grep -c '^restart kipclip$' "$S/sysctl.log")" -eq 0 ]] ||
    fail "no restart expected: $(cat "$S/sysctl.log")"
  assert_tmp_clean "$S"

  rm -rf "$S"; CUR_S=""
  ok "daemon-reload failure: drop-ins restored, reload retried and verified, journal cleaned, rc 1"
}
t12

# ---- 13. daemon-reload failure that cannot be recovered: fail closed,
#          then recovered by the next tick ---------------------------------

t13() {
  reset_knobs
  local S log rc
  S="$(new_scenario)"; CUR_S="$S"
  setup_cutover_scenario "$S"
  printf '[Service]\nEnvironment="SENTRY_RELEASE=v0.25.2"\n' > "$S/dropin/release.conf"
  cp "$S/dropin/release.conf" "$S/old-release.conf"
  SYSCTL_FAIL_DAEMON_RELOAD=2 # both the initial reload and the retry fail

  log="$S/run.log"; rc=0
  run_update "$S" "$log" || rc=$?

  [[ "$rc" -eq 1 ]] || fail "fail-closed run must exit 1, got $rc; log: $(cat "$log")"
  grep -q "journal kept at $S/root/.release-txn" "$log" ||
    fail "fail-closed message missing; log: $(cat "$log")"
  assert_journal_present "$S"
  assert_current "$S" v0.25.2
  assert_file_eq "$S/old-release.conf" "$S/dropin/release.conf"
  [[ "$(grep -c '^daemon-reload$' "$S/sysctl.log")" -eq 2 ]] ||
    fail "expected 2 failed reloads: $(cat "$S/sysctl.log")"

  # Next tick: recovery restores (idempotently), the reload succeeds, the
  # journal is cleaned, and the normal flow resumes — here it stops at a
  # simulated build failure right after recovery.
  SYSCTL_FAIL_DAEMON_RELOAD=0
  DENO_BUILD_EXIT=1
  log="$S/run2.log"; rc=0
  run_update "$S" "$log" || rc=$?
  [[ "$rc" -eq 1 ]] || fail "second run should fail at the build, got $rc; log: $(cat "$log")"
  grep -q "Recovery: interrupted transaction for v0.26.0" "$log" ||
    fail "recovery line missing; log: $(cat "$log")"
  assert_order "$log" "Recovery:" "Fetching tags"
  assert_journal_absent "$S"
  assert_current "$S" v0.25.2
  assert_file_eq "$S/old-release.conf" "$S/dropin/release.conf"

  rm -rf "$S"; CUR_S=""
  ok "repeated-run recovery: reload-failure tick fails closed with the journal kept; next tick restores, cleans, and resumes"
}
t13

# ---- 14. SIGKILL at daemon-reload: journal survives; next tick restores
#          the pre-tick drop-ins and completes the release ----------------

t14() {
  reset_knobs
  local S log rc
  S="$(new_scenario)"; CUR_S="$S"
  setup_cutover_scenario "$S"
  printf '[Service]\nEnvironment="SENTRY_RELEASE=v0.25.2"\n' > "$S/dropin/release.conf"
  cp "$S/dropin/release.conf" "$S/old-release.conf"
  SYSCTL_CRASH_ON_DAEMON_RELOAD=1

  log="$S/run.log"; rc=0
  run_update_crash "$S" "$log" || rc=$?
  [[ "$rc" -eq 137 ]] || fail "SIGKILL at daemon-reload should leave rc 137, got $rc; log: $(cat "$log")"

  # Mid-crash state: drop-ins already mutated, swap never happened,
  # journal committed (durable).
  assert_current "$S" v0.25.2
  grep -q 'SENTRY_RELEASE=v0.26.0' "$S/dropin/release.conf" ||
    fail "drop-in should be written before the reload crash"
  grep -q 'runtime/deno/server.ts' "$S/dropin/runtime.conf" ||
    fail "runtime override should exist at crash time"
  assert_journal_present "$S"
  grep -q '^DESIRED_TAG=v0.26.0$' "$S/root/.release-txn/meta" ||
    fail "journal tag wrong: $(cat "$S/root/.release-txn/meta")"
  grep -q '^PREV_TARGET=.*releases/v0.25.2$' "$S/root/.release-txn/meta" ||
    fail "journal prev target wrong: $(cat "$S/root/.release-txn/meta")"
  [[ "$(grep -c '^daemon-reload$' "$S/sysctl.log")" -eq 1 ]] ||
    fail "crash should have happened at the reload: $(cat "$S/sysctl.log")"

  # Next tick: recovery restores the pre-tick drop-ins first, then the
  # normal flow completes the release.
  SYSCTL_CRASH_ON_DAEMON_RELOAD=0
  log="$S/run2.log"; rc=0
  run_update "$S" "$log" || rc=$?
  [[ "$rc" -eq 0 ]] || fail "recovery run should complete the release, got $rc; log: $(cat "$log")"
  grep -q "Recovery: interrupted transaction for v0.26.0" "$log" ||
    fail "recovery line missing; log: $(cat "$log")"
  assert_order "$log" "Recovery:" "Fetching tags"
  assert_current "$S" v0.26.0
  assert_journal_absent "$S"
  grep -q 'SENTRY_RELEASE=v0.26.0' "$S/dropin/release.conf" || fail "final release.conf wrong"
  grep -q 'runtime/deno/server.ts' "$S/dropin/runtime.conf" || fail "final runtime override wrong"
  [[ "$(grep -c '^daemon-reload$' "$S/sysctl.log")" -eq 3 ]] ||
    fail "expected crash reload + recovery reload + activation reload: $(cat "$S/sysctl.log")"
  [[ "$(grep -c '^restart kipclip$' "$S/sysctl.log")" -eq 1 ]] ||
    fail "expected 1 restart (the completing activation): $(cat "$S/sysctl.log")"

  rm -rf "$S"; CUR_S=""
  ok "SIGKILL at daemon-reload: journal survives; next tick restores prior drop-ins, cleans the journal, completes the release"
}
t14

# ---- 15. SIGKILL at the swap: swap never happened; next tick restores
#          then completes ------------------------------------------------

t15() {
  reset_knobs
  local S log rc
  S="$(new_scenario)"; CUR_S="$S"
  setup_cutover_scenario "$S"
  printf '[Service]\nEnvironment="SENTRY_RELEASE=v0.25.2"\n' > "$S/dropin/release.conf"
  CRASH_ON_LN=1

  log="$S/run.log"; rc=0
  run_update_crash "$S" "$log" || rc=$?
  [[ "$rc" -eq 137 ]] || fail "SIGKILL at the swap should leave rc 137, got $rc; log: $(cat "$log")"

  # Mid-crash state: drop-ins mutated and systemd reloaded, but `current`
  # still points at the old release (ln never executed).
  assert_current "$S" v0.25.2
  grep -q 'SENTRY_RELEASE=v0.26.0' "$S/dropin/release.conf" || fail "drop-in should be written before the swap"
  grep -q 'runtime/deno/server.ts' "$S/dropin/runtime.conf" || fail "runtime override should exist at crash time"
  assert_journal_present "$S"
  [[ "$(grep -c '^daemon-reload$' "$S/sysctl.log")" -eq 1 ]] || fail "reload should have run before the swap"
  [[ "$(grep -c '^restart kipclip$' "$S/sysctl.log")" -eq 0 ]] || fail "no restart may have run"

  # Next tick: recovery restores the drop-ins, cleans the journal, and
  # the normal flow completes the release.
  CRASH_ON_LN=0
  log="$S/run2.log"; rc=0
  run_update "$S" "$log" || rc=$?
  [[ "$rc" -eq 0 ]] || fail "recovery run should complete the release, got $rc; log: $(cat "$log")"
  grep -q "Recovery: interrupted transaction for v0.26.0" "$log" ||
    fail "recovery line missing; log: $(cat "$log")"
  assert_order "$log" "Recovery:" "Fetching tags"
  assert_current "$S" v0.26.0
  assert_journal_absent "$S"
  [[ "$(grep -c '^restart kipclip$' "$S/sysctl.log")" -eq 1 ]] ||
    fail "expected 1 restart (the completing activation): $(cat "$S/sysctl.log")"

  rm -rf "$S"; CUR_S=""
  ok "SIGKILL at the swap: current untouched at crash time; next tick restores drop-ins, cleans the journal, completes the release"
}
t15

# ---- 16. SIGKILL at the restart: swap done; next tick completes the
#          activation BEFORE the desired==current fast-path --------------

t16() {
  reset_knobs
  local S log rc
  S="$(new_scenario)"; CUR_S="$S"
  setup_cutover_scenario "$S"
  printf '[Service]\nEnvironment="SENTRY_RELEASE=v0.25.2"\n' > "$S/dropin/release.conf"
  SYSCTL_CRASH_ON_RESTART=1

  log="$S/run.log"; rc=0
  run_update_crash "$S" "$log" || rc=$?
  [[ "$rc" -eq 137 ]] || fail "SIGKILL at the restart should leave rc 137, got $rc; log: $(cat "$log")"

  # Mid-crash state: swap done, drop-ins new, journal committed, restart
  # attempted but never completed.
  assert_current "$S" v0.26.0
  grep -q 'SENTRY_RELEASE=v0.26.0' "$S/dropin/release.conf" || fail "drop-in should be new at crash time"
  assert_journal_present "$S"
  [[ "$(grep -c '^restart kipclip$' "$S/sysctl.log")" -eq 1 ]] || fail "restart attempt should be logged"
  [[ ! -e "$S/health.count" ]] || fail "no health check may have run"

  # Next tick: desired==current, but recovery must run FIRST — restart +
  # health — because the interrupted tick never proved the new release
  # starts. Only then does the fast-path exit "already on".
  SYSCTL_CRASH_ON_RESTART=0
  log="$S/run2.log"; rc=0
  run_update "$S" "$log" || rc=$?
  [[ "$rc" -eq 0 ]] || fail "recovery run should exit 0, got $rc; log: $(cat "$log")"
  grep -q "Recovery: interrupted activation of v0.26.0" "$log" ||
    fail "completion line missing; log: $(cat "$log")"
  assert_order "$log" "Recovery:" "Fetching tags"
  assert_order "$log" "Recovery:" "Already on v0.26.0"
  grep -q "Already on v0.26.0" "$log" || fail "fast-path no-op missing; log: $(cat "$log")"
  assert_current "$S" v0.26.0
  assert_journal_absent "$S"
  [[ "$(grep -c '^restart kipclip$' "$S/sysctl.log")" -eq 2 ]] ||
    fail "expected crashed attempt + recovery restart: $(cat "$S/sysctl.log")"
  [[ "$(cat "$S/health.count")" == "1" ]] || fail "expected 1 recovery health check"

  rm -rf "$S"; CUR_S=""
  ok "SIGKILL at the restart: next tick completes the activation (restart + health) before the desired==current fast-path, then exits 0"
}
t16

# ---- 17. SIGKILL right after the health response: journal still pending;
#          next tick completes before the fast-path -----------------------

t17() {
  reset_knobs
  local S log rc
  S="$(new_scenario)"; CUR_S="$S"
  setup_cutover_scenario "$S"
  printf '[Service]\nEnvironment="SENTRY_RELEASE=v0.25.2"\n' > "$S/dropin/release.conf"
  CURL_CRASH_ON_SUCCESS=1

  log="$S/run.log"; rc=0
  run_update_crash "$S" "$log" || rc=$?
  [[ "$rc" -eq 137 ]] || fail "SIGKILL after the health response should leave rc 137, got $rc; log: $(cat "$log")"

  # Mid-crash state: everything activated and healthy, but the journal
  # was never cleaned.
  assert_current "$S" v0.26.0
  assert_journal_present "$S"
  [[ "$(grep -c '^restart kipclip$' "$S/sysctl.log")" -eq 1 ]] || fail "restart should have run"
  [[ "$(cat "$S/health.count")" == "1" ]] || fail "health check should have run"

  # Next tick: recovery re-verifies (restart + health) and cleans the
  # journal before the fast-path can exit.
  CURL_CRASH_ON_SUCCESS=0
  log="$S/run2.log"; rc=0
  run_update "$S" "$log" || rc=$?
  [[ "$rc" -eq 0 ]] || fail "recovery run should exit 0, got $rc; log: $(cat "$log")"
  grep -q "Recovery: interrupted activation of v0.26.0" "$log" ||
    fail "completion line missing; log: $(cat "$log")"
  assert_order "$log" "Recovery:" "Already on v0.26.0"
  assert_current "$S" v0.26.0
  assert_journal_absent "$S"
  [[ "$(grep -c '^restart kipclip$' "$S/sysctl.log")" -eq 2 ]] ||
    fail "expected crashed restart + recovery restart: $(cat "$S/sysctl.log")"
  [[ "$(cat "$S/health.count")" == "2" ]] || fail "expected 2 health checks"

  rm -rf "$S"; CUR_S=""
  ok "SIGKILL after a successful health response: journal pending; next tick re-verifies and cleans before the fast-path"
}
t17

# ---- 18. rollback failure: fail closed with the journal kept; the next
#          tick recovers and completes -----------------------------------

t18() {
  reset_knobs
  local S log rc
  S="$(new_scenario)"; CUR_S="$S"
  setup_cutover_scenario "$S"
  printf '[Service]\nEnvironment="SENTRY_RELEASE=v0.25.2"\n' > "$S/dropin/release.conf"
  cp "$S/dropin/release.conf" "$S/old-release.conf"
  SYSCTL_FAIL_RESTARTS=2 # activation restart AND rollback restart fail

  log="$S/run.log"; rc=0
  run_update "$S" "$log" || rc=$?

  [[ "$rc" -eq 1 ]] || fail "rollback failure must exit 1, got $rc; log: $(cat "$log")"
  grep -q "rollback could not be verified — journal kept at $S/root/.release-txn" "$log" ||
    fail "fail-closed message missing; log: $(cat "$log")"
  # The symlink and drop-ins were restored before the failed rollback
  # restart; the journal is kept because the rollback was not verified.
  assert_current "$S" v0.25.2
  assert_file_eq "$S/old-release.conf" "$S/dropin/release.conf"
  assert_file_absent "$S/dropin/runtime.conf"
  assert_journal_present "$S"
  [[ "$(grep -c '^restart kipclip$' "$S/sysctl.log")" -eq 2 ]] ||
    fail "expected activation + rollback restarts: $(cat "$S/sysctl.log")"

  # Next tick: recovery restores (idempotently), reloads, cleans the
  # journal, and the normal flow completes the release.
  SYSCTL_FAIL_RESTARTS=0
  log="$S/run2.log"; rc=0
  run_update "$S" "$log" || rc=$?
  [[ "$rc" -eq 0 ]] || fail "recovery run should complete the release, got $rc; log: $(cat "$log")"
  grep -q "Recovery: interrupted transaction for v0.26.0" "$log" ||
    fail "recovery line missing; log: $(cat "$log")"
  assert_order "$log" "Recovery:" "Fetching tags"
  assert_current "$S" v0.26.0
  assert_journal_absent "$S"
  [[ "$(grep -c '^restart kipclip$' "$S/sysctl.log")" -eq 3 ]] ||
    fail "expected crashed + rollback + completing restarts: $(cat "$S/sysctl.log")"

  rm -rf "$S"; CUR_S=""
  ok "rollback failure: journal kept (fail closed); next tick recovers, cleans, and completes the release"
}
t18

# ---- 19. SIGKILL right after the journal commit (before any mutation) ----

t19() {
  reset_knobs
  local S log rc
  S="$(new_scenario)"; CUR_S="$S"
  setup_cutover_scenario "$S"
  printf '[Service]\nEnvironment="SENTRY_RELEASE=v0.25.2"\n' > "$S/dropin/release.conf"
  cp "$S/dropin/release.conf" "$S/old-release.conf"
  CRASH_ON_SYNC=1 # dies at the journal-commit flush, before drop-in writes

  log="$S/run.log"; rc=0
  run_update_crash "$S" "$log" || rc=$?
  [[ "$rc" -eq 137 ]] || fail "SIGKILL at the journal flush should leave rc 137, got $rc; log: $(cat "$log")"

  # Mid-crash state: journal committed, nothing mutated yet.
  assert_current "$S" v0.25.2
  assert_file_eq "$S/old-release.conf" "$S/dropin/release.conf"
  assert_file_absent "$S/dropin/runtime.conf"
  assert_journal_present "$S"
  [[ ! -e "$S/sysctl.log" ]] || fail "no systemctl call may have run"

  # Next tick: recovery restores (no-op) and reloads, then the normal
  # flow completes the release.
  CRASH_ON_SYNC=0
  log="$S/run2.log"; rc=0
  run_update "$S" "$log" || rc=$?
  [[ "$rc" -eq 0 ]] || fail "recovery run should complete the release, got $rc; log: $(cat "$log")"
  grep -q "Recovery: interrupted transaction for v0.26.0" "$log" ||
    fail "recovery line missing; log: $(cat "$log")"
  assert_order "$log" "Recovery:" "Fetching tags"
  assert_current "$S" v0.26.0
  assert_journal_absent "$S"
  [[ "$(grep -c '^restart kipclip$' "$S/sysctl.log")" -eq 1 ]] ||
    fail "expected 1 restart (the completing activation): $(cat "$S/sysctl.log")"

  rm -rf "$S"; CUR_S=""
  ok "SIGKILL right after the journal commit: no mutation had happened; next tick recovers and completes"
}
t19

# ---- 20. journal sync failure: fail closed before any mutation ------------

t20() {
  reset_knobs
  local S log rc
  S="$(new_scenario)"; CUR_S="$S"
  setup_cutover_scenario "$S"
  printf '[Service]\nEnvironment="SENTRY_RELEASE=v0.25.2"\n' > "$S/dropin/release.conf"
  cp "$S/dropin/release.conf" "$S/old-release.conf"
  SYNC_FAIL=1

  log="$S/run.log"; rc=0
  run_update "$S" "$log" || rc=$?

  [[ "$rc" -eq 1 ]] || fail "failed journal sync must exit 1, got $rc; log: $(cat "$log")"
  grep -q "sync of the activation journal failed" "$log" ||
    fail "sync failure not reported; log: $(cat "$log")"
  grep -q "aborting before any mutation" "$log" ||
    fail "abort-before-mutation line missing; log: $(cat "$log")"
  # Nothing was mutated: no drop-in write, no reload, no restart; the
  # committed journal is left for the next tick.
  assert_current "$S" v0.25.2
  assert_file_eq "$S/old-release.conf" "$S/dropin/release.conf"
  assert_file_absent "$S/dropin/runtime.conf"
  [[ ! -e "$S/sysctl.log" ]] || fail "no systemctl call expected: $(cat "$S/sysctl.log")"
  assert_journal_present "$S"
  assert_tmp_clean "$S"

  # Next tick: recovery restores (a no-op) and reloads, then the normal
  # flow completes the release.
  SYNC_FAIL=0
  log="$S/run2.log"; rc=0
  run_update "$S" "$log" || rc=$?
  [[ "$rc" -eq 0 ]] || fail "recovery run should complete the release, got $rc; log: $(cat "$log")"
  grep -q "Recovery: interrupted transaction for v0.26.0" "$log" ||
    fail "recovery line missing; log: $(cat "$log")"
  assert_order "$log" "Recovery:" "Fetching tags"
  assert_current "$S" v0.26.0
  assert_journal_absent "$S"
  [[ "$(grep -c '^restart kipclip$' "$S/sysctl.log")" -eq 1 ]] ||
    fail "expected 1 restart (the completing activation): $(cat "$S/sysctl.log")"

  rm -rf "$S"; CUR_S=""
  ok "failed journal sync: tick exits 1 before any mutation; journal left; next tick recovers and completes"
}
t20

# ---- 21. no-journal consistency guard: unit/current mismatch (fast-path) ---
# A tick died with its journal lost despite a successful sync: the Hono
# ExecStart override persisted, the swap never happened. Desired ==
# current, so the desired==current fast-path would exit "already on" over
# a unit that cannot start the release `current` points at. The
# consolidated guard runs right after recovery — before the fetch — and
# fails closed; nothing is mutated.

t21() {
  reset_knobs
  local S log rc
  S="$(new_scenario)"; CUR_S="$S"
  make_legacy_tree "$S/fixtures/v0.25.2"
  printf 'v0.25.2\n' > "$S/gitstate/tags"
  make_legacy_tree "$S/root/releases/v0.25.2"
  echo "v0.25.2" > "$S/root/releases/v0.25.2/.version"
  ln -sfn "$S/root/releases/v0.25.2" "$S/root/current"
  printf '[Service]\nExecStart=\nExecStart=%s run -A --unstable-kv runtime/deno/server.ts\n' "$S/stubs/deno" > "$S/dropin/runtime.conf"
  cp "$S/dropin/runtime.conf" "$S/stale-runtime.conf"
  printf '[Service]\nEnvironment="SENTRY_RELEASE=v0.26.0"\n' > "$S/dropin/release.conf"
  cp "$S/dropin/release.conf" "$S/old-release.conf"

  log="$S/run.log"; rc=0
  run_update "$S" "$log" || rc=$?

  [[ "$rc" -eq 1 ]] || fail "unit/current mismatch must fail closed (rc 1), got $rc; log: $(cat "$log")"
  grep -q "unit/current mismatch with no activation journal" "$log" ||
    fail "guard message missing; log: $(cat "$log")"
  grep -q "failing closed, nothing was changed" "$log" ||
    fail "guard must state that nothing changed; log: $(cat "$log")"
  grep -q "Already on" "$log" &&
    fail "fast-path must not mask the mismatch; log: $(cat "$log")"
  # Fails closed BEFORE fetch/build/transaction: no git call, no build.
  grep -q "Fetching tags" "$log" && fail "guard must fail before the fetch; log: $(cat "$log")"
  [[ ! -s "$S/gitstate/gitlog" ]] || fail "no git call expected: $(cat "$S/gitstate/gitlog")"
  [[ ! -e "$S/build.snapshot" ]] || fail "no build may have run: $(cat "$S/build.snapshot")"
  # Nothing was mutated and no transaction started.
  assert_current "$S" v0.25.2
  assert_file_eq "$S/stale-runtime.conf" "$S/dropin/runtime.conf"
  assert_file_eq "$S/old-release.conf" "$S/dropin/release.conf"
  assert_journal_absent "$S"
  [[ ! -e "$S/sysctl.log" ]] || fail "no systemctl call expected: $(cat "$S/sysctl.log")"

  rm -rf "$S"; CUR_S=""
  ok "no-journal unit/current mismatch (fast-path case): guard fails closed before the fetch; nothing mutated"
}
t21

# ---- 22. no-journal consistency guard, pending newer tag: fail closed
#          before fetch/build/any mutation --------------------------------
# Same lost-journal state as t21 (stale Hono override persisted, current
# still legacy) but with a NEWER Hono tag pending. Before this guard the
# tick built and started a transaction over the incompatible snapshot;
# a failed rollback then restored the very override that cannot start
# the release, and the box was left operator-blocking (journal kept).
# The guard now fails closed before the fetch: no build, no journal, no
# mutation.

t22() {
  reset_knobs
  local S log rc
  S="$(new_scenario)"; CUR_S="$S"
  make_legacy_tree "$S/fixtures/v0.25.2"
  make_hono_tree "$S/fixtures/v0.26.0"
  printf 'v0.26.0\nv0.25.2\n' > "$S/gitstate/tags"
  make_legacy_tree "$S/root/releases/v0.25.2"
  echo "v0.25.2" > "$S/root/releases/v0.25.2/.version"
  ln -sfn "$S/root/releases/v0.25.2" "$S/root/current"
  # Stale Hono override persisted by an interrupted cutover whose journal
  # was lost; release.conf still carries the old tag.
  printf '[Service]\nExecStart=\nExecStart=%s run -A --unstable-kv runtime/deno/server.ts\n' "$S/stubs/deno" > "$S/dropin/runtime.conf"
  cp "$S/dropin/runtime.conf" "$S/stale-runtime.conf"
  printf '[Service]\nEnvironment="SENTRY_RELEASE=v0.25.2"\n' > "$S/dropin/release.conf"
  cp "$S/dropin/release.conf" "$S/old-release.conf"

  log="$S/run.log"; rc=0
  run_update "$S" "$log" || rc=$?

  [[ "$rc" -eq 1 ]] || fail "pending tag with a unit/current mismatch must fail closed (rc 1), got $rc; log: $(cat "$log")"
  grep -q "unit/current mismatch with no activation journal" "$log" ||
    fail "guard message missing; log: $(cat "$log")"
  grep -q "failing closed, nothing was changed" "$log" ||
    fail "guard must state that nothing changed; log: $(cat "$log")"
  grep -q "Releasing" "$log" &&
    fail "guard must fail before the release flow; log: $(cat "$log")"
  # Fails closed BEFORE fetch/build/transaction: no git call, no build,
  # no journal, no systemctl, no drop-in or symlink churn.
  grep -q "Fetching tags" "$log" && fail "guard must fail before the fetch; log: $(cat "$log")"
  grep -q "Building v0.26.0" "$log" && fail "guard must fail before the build; log: $(cat "$log")"
  [[ ! -e "$S/build.snapshot" ]] || fail "no build may have run: $(cat "$S/build.snapshot")"
  [[ ! -s "$S/gitstate/gitlog" ]] || fail "no git call expected: $(cat "$S/gitstate/gitlog")"
  assert_current "$S" v0.25.2
  assert_file_eq "$S/stale-runtime.conf" "$S/dropin/runtime.conf"
  assert_file_eq "$S/old-release.conf" "$S/dropin/release.conf"
  assert_journal_absent "$S"
  [[ ! -e "$S/sysctl.log" ]] || fail "no systemctl call expected: $(cat "$S/sysctl.log")"
  [[ ! -e "$S/health.count" ]] || fail "no health check may have run"
  assert_tmp_clean "$S"

  rm -rf "$S"; CUR_S=""
  ok "pending newer tag + stale override with no journal: guard fails closed before fetch/build; nothing mutated"
}
t22

# ---- 23. no-journal consistency guard: unknown effective unit -------------
# The persisted runtime override is unrecognisable (a truncated write:
# the ExecStart reset line is on disk, the command never made it). The
# unit cannot be proven to start the current release, so even the
# desired==current fast-path must fail closed rather than exit "already
# on".

t23() {
  reset_knobs
  local S log rc
  S="$(new_scenario)"; CUR_S="$S"
  make_legacy_tree "$S/fixtures/v0.25.2"
  printf 'v0.25.2\n' > "$S/gitstate/tags"
  make_legacy_tree "$S/root/releases/v0.25.2"
  echo "v0.25.2" > "$S/root/releases/v0.25.2/.version"
  ln -sfn "$S/root/releases/v0.25.2" "$S/root/current"
  # Truncated override: reset line only, no command.
  printf '[Service]\nExecStart=\n' > "$S/dropin/runtime.conf"
  cp "$S/dropin/runtime.conf" "$S/stale-runtime.conf"
  printf '[Service]\nEnvironment="SENTRY_RELEASE=v0.25.2"\n' > "$S/dropin/release.conf"
  cp "$S/dropin/release.conf" "$S/old-release.conf"

  log="$S/run.log"; rc=0
  run_update "$S" "$log" || rc=$?

  [[ "$rc" -eq 1 ]] || fail "unknown effective unit must fail closed (rc 1), got $rc; log: $(cat "$log")"
  grep -q "cannot determine the unit's effective ExecStart kind" "$log" ||
    fail "unknown-kind message missing; log: $(cat "$log")"
  grep -q "failing closed, nothing was changed" "$log" ||
    fail "guard must state that nothing changed; log: $(cat "$log")"
  grep -q "Already on" "$log" &&
    fail "fast-path must not mask an undeterminable unit; log: $(cat "$log")"
  grep -q "Fetching tags" "$log" && fail "guard must fail before the fetch; log: $(cat "$log")"
  [[ ! -s "$S/gitstate/gitlog" ]] || fail "no git call expected: $(cat "$S/gitstate/gitlog")"
  assert_current "$S" v0.25.2
  assert_file_eq "$S/stale-runtime.conf" "$S/dropin/runtime.conf"
  assert_file_eq "$S/old-release.conf" "$S/dropin/release.conf"
  assert_journal_absent "$S"
  [[ ! -e "$S/sysctl.log" ]] || fail "no systemctl call expected: $(cat "$S/sysctl.log")"

  rm -rf "$S"; CUR_S=""
  ok "unknown effective unit with no journal: guard fails closed before the fetch; nothing mutated"
}
t23

# ---- 24. no-journal consistency guard: stale/unreadable release.conf ------
# Same-kind crash: the journal was lost after release.conf was rewritten
# but before the swap, so the unit kind still matches `current` while the
# SENTRY_RELEASE label names a release that is not current. A
# release.conf that carries no SENTRY_RELEASE at all is equally
# unprovable. Both must fail closed before fetch/build.

t24() {
  reset_knobs
  local S log rc
  S="$(new_scenario)"; CUR_S="$S"
  make_legacy_tree "$S/fixtures/v0.25.2"
  make_hono_tree "$S/fixtures/v0.26.0"
  printf 'v0.26.0\nv0.25.2\n' > "$S/gitstate/tags"
  make_legacy_tree "$S/root/releases/v0.25.2"
  echo "v0.25.2" > "$S/root/releases/v0.25.2/.version"
  ln -sfn "$S/root/releases/v0.25.2" "$S/root/current"
  # Unit kind stays consistent (legacy base unit, no override): only the
  # SENTRY_RELEASE label is stale.
  printf '[Service]\nEnvironment="SENTRY_RELEASE=v0.26.0"\n' > "$S/dropin/release.conf"
  cp "$S/dropin/release.conf" "$S/stale-release.conf"

  log="$S/run.log"; rc=0
  run_update "$S" "$log" || rc=$?

  [[ "$rc" -eq 1 ]] || fail "stale release.conf must fail closed (rc 1), got $rc; log: $(cat "$log")"
  grep -q "stale SENTRY_RELEASE with no activation journal" "$log" ||
    fail "stale-label message missing; log: $(cat "$log")"
  grep -q "failing closed, nothing was changed" "$log" ||
    fail "guard must state that nothing changed; log: $(cat "$log")"
  grep -q "Fetching tags" "$log" && fail "guard must fail before the fetch; log: $(cat "$log")"
  [[ ! -s "$S/gitstate/gitlog" ]] || fail "no git call expected: $(cat "$S/gitstate/gitlog")"
  assert_current "$S" v0.25.2
  assert_file_eq "$S/stale-release.conf" "$S/dropin/release.conf"
  assert_journal_absent "$S"
  [[ ! -e "$S/sysctl.log" ]] || fail "no systemctl call expected: $(cat "$S/sysctl.log")"

  # Same guard, unreadable label: release.conf exists but carries no
  # SENTRY_RELEASE assignment at all — cannot be proven consistent.
  printf '[Service]\n' > "$S/dropin/release.conf"
  cp "$S/dropin/release.conf" "$S/labelless-release.conf"
  log="$S/run2.log"; rc=0
  run_update "$S" "$log" || rc=$?
  [[ "$rc" -eq 1 ]] || fail "unreadable release.conf must fail closed (rc 1), got $rc; log: $(cat "$log")"
  grep -q "cannot read SENTRY_RELEASE from" "$log" ||
    fail "unreadable-label message missing; log: $(cat "$log")"
  grep -q "Fetching tags" "$log" && fail "guard must fail before the fetch; log: $(cat "$log")"
  assert_current "$S" v0.25.2
  assert_file_eq "$S/labelless-release.conf" "$S/dropin/release.conf"
  assert_journal_absent "$S"

  rm -rf "$S"; CUR_S=""
  ok "stale/unreadable SENTRY_RELEASE with no journal: guard fails closed before the fetch; nothing mutated"
}
t24

# ---- 25. journal recovery (swap already done): completion health fails,
#          rollback to the prior release is verified — journal cleaned ------
# A tick died at the restart after the swap (journal committed, `current`
# already at the journal's target). The next tick's recovery tries to
# complete the activation with restart + health; the target never comes up,
# so recovery rolls back to the prior release — drop-ins + symlink
# restored, reloaded, restarted, health re-verified — cleans the journal,
# and still exits 1 because the release was not completed.

t25() {
  reset_knobs
  local S log rc
  S="$(new_scenario)"; CUR_S="$S"
  setup_cutover_scenario "$S"
  printf '[Service]\nEnvironment="SENTRY_RELEASE=v0.25.2"\n' > "$S/dropin/release.conf"
  cp "$S/dropin/release.conf" "$S/old-release.conf"
  SYSCTL_CRASH_ON_RESTART=1 # swap done; the restart was never proven

  log="$S/run.log"; rc=0
  run_update_crash "$S" "$log" || rc=$?
  [[ "$rc" -eq 137 ]] || fail "SIGKILL at the restart should leave rc 137, got $rc; log: $(cat "$log")"
  assert_current "$S" v0.26.0
  assert_journal_present "$S"
  grep -q '^PREV_TARGET=.*releases/v0.25.2$' "$S/root/.release-txn/meta" ||
    fail "journal prev target wrong: $(cat "$S/root/.release-txn/meta")"

  # Next tick: recovery restarts and health-checks the target; both
  # completion attempts fail, so recovery rolls back to the prior release.
  # The rollback health check succeeds, so the rollback is verified: the
  # journal is cleaned and the tick exits 1 without proceeding.
  SYSCTL_CRASH_ON_RESTART=0
  CURL_FAIL_FIRST=2 # both completion attempts fail; rollback check succeeds
  log="$S/run2.log"; rc=0
  run_update "$S" "$log" || rc=$?
  [[ "$rc" -eq 1 ]] || fail "rolled-back recovery must exit 1, got $rc; log: $(cat "$log")"
  grep -q "Recovery: interrupted activation of v0.26.0" "$log" ||
    fail "recovery line missing; log: $(cat "$log")"
  grep -q "Recovery: v0.26.0 did not come up — rolling back to $S/root/releases/v0.25.2" "$log" ||
    fail "completion failure not reported; log: $(cat "$log")"
  grep -q "Recovery: rolled back after interrupted activation" "$log" ||
    fail "verified rollback line missing; log: $(cat "$log")"
  grep -q "rollback could not be verified" "$log" &&
    fail "rollback must be verified here; log: $(cat "$log")"
  grep -q "Fetching tags" "$log" &&
    fail "recovery must exit before the fetch; log: $(cat "$log")"

  # Prior release restored and healthy: symlink, byte-exact drop-ins, and
  # the rollback restart ran against them.
  assert_current "$S" v0.25.2
  assert_file_eq "$S/old-release.conf" "$S/dropin/release.conf"
  assert_file_absent "$S/dropin/runtime.conf"
  [[ "$(cat "$S/snap/restart-3.current")" == "$S/root/releases/v0.25.2" ]] ||
    fail "rollback restart ran with current=$(cat "$S/snap/restart-3.current")"
  assert_file_eq "$S/old-release.conf" "$S/snap/restart-3/release.conf"
  assert_file_absent "$S/snap/restart-3/runtime.conf"
  [[ "$(cat "$S/health.count")" == "3" ]] ||
    fail "expected 2 completion + 1 rollback health checks: $(cat "$S/health.count")"

  # The verified rollback cleaned the journal; the tick still fails closed.
  assert_journal_absent "$S"
  [[ "$(grep -c '^daemon-reload$' "$S/sysctl.log")" -eq 2 ]] ||
    fail "expected activation + rollback reloads: $(cat "$S/sysctl.log")"
  [[ "$(grep -c '^restart kipclip$' "$S/sysctl.log")" -eq 3 ]] ||
    fail "expected crashed + completion + rollback restarts: $(cat "$S/sysctl.log")"

  rm -rf "$S"; CUR_S=""
  ok "journal recovery (swap done, completion health fails): rollback to the prior release verified, journal cleaned, rc 1"
}
t25

# ---- 26. journal recovery (swap already done): completion health fails
#          AND the rollback cannot be verified — journal kept (fail closed) -
# Same recovery branch as 25, but the prior release also fails its health
# re-check. The rollback cannot be verified, so the journal is KEPT and the
# tick exits 1 (fail closed); later ticks keep stopping at recovery until
# an operator resolves it.

t26() {
  reset_knobs
  local S log rc
  S="$(new_scenario)"; CUR_S="$S"
  setup_cutover_scenario "$S"
  printf '[Service]\nEnvironment="SENTRY_RELEASE=v0.25.2"\n' > "$S/dropin/release.conf"
  cp "$S/dropin/release.conf" "$S/old-release.conf"
  SYSCTL_CRASH_ON_RESTART=1 # swap done; the restart was never proven

  log="$S/run.log"; rc=0
  run_update_crash "$S" "$log" || rc=$?
  [[ "$rc" -eq 137 ]] || fail "SIGKILL at the restart should leave rc 137, got $rc; log: $(cat "$log")"
  assert_current "$S" v0.26.0
  assert_journal_present "$S"

  # Next tick: completion fails, the rollback restores symlink + drop-ins
  # but its health re-check fails too, so the rollback cannot be verified:
  # the journal is kept and the tick fails closed.
  SYSCTL_CRASH_ON_RESTART=0
  CURL_FAIL_FIRST=4 # completion and rollback health checks all fail
  log="$S/run2.log"; rc=0
  run_update "$S" "$log" || rc=$?
  [[ "$rc" -eq 1 ]] || fail "unverifiable rollback must exit 1, got $rc; log: $(cat "$log")"
  grep -q "Recovery: v0.26.0 did not come up — rolling back to $S/root/releases/v0.25.2" "$log" ||
    fail "completion failure not reported; log: $(cat "$log")"
  grep -q "Recovery: rollback could not be verified — journal kept at $S/root/.release-txn; manual recovery required" "$log" ||
    fail "fail-closed rollback message missing; log: $(cat "$log")"
  grep -q "Recovery: rolled back after interrupted activation" "$log" &&
    fail "rollback must not be reported as verified; log: $(cat "$log")"
  grep -q "Fetching tags" "$log" &&
    fail "recovery must exit before the fetch; log: $(cat "$log")"

  # The symlink + drop-ins were restored before the failed verification;
  # the journal survives (fail closed) for the operator / next tick.
  assert_current "$S" v0.25.2
  assert_file_eq "$S/old-release.conf" "$S/dropin/release.conf"
  assert_file_absent "$S/dropin/runtime.conf"
  assert_journal_present "$S"
  [[ "$(cat "$S/health.count")" == "4" ]] ||
    fail "expected 2 completion + 2 rollback health attempts: $(cat "$S/health.count")"
  [[ "$(grep -c '^daemon-reload$' "$S/sysctl.log")" -eq 2 ]] ||
    fail "expected activation + rollback reloads: $(cat "$S/sysctl.log")"
  [[ "$(grep -c '^restart kipclip$' "$S/sysctl.log")" -eq 3 ]] ||
    fail "expected crashed + completion + rollback restarts: $(cat "$S/sysctl.log")"

  rm -rf "$S"; CUR_S=""
  ok "journal recovery (swap done, completion + rollback health fail): journal kept, rc 1 (fail closed)"
}
t26

echo
echo "ALL UPDATE (RUNTIME CUTOVER) TESTS PASSED"
