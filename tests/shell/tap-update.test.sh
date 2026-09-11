#!/usr/bin/env bash
# Regression tests for deploy/release/tap-update.sh.
#
# Pins (release blockers):
#   1. resolve_ref() emits ONLY the resolved sha on stdout — the caller
#      captures stdout as DESIRED_REF — with all diagnostics on stderr.
#   2. Branch refs (e.g. `origin/main`) are refused with a clear error.
#   3. A FAILED `systemctl restart tap` enters the rollback path and
#      restores the previous binary + recorded sha/version files (the old
#      `set -e` would exit before rollback).
#   4. bash 3.2 syntax-clean (uses only POSIX + bash 3.2 constructs).
#   5. main() is IDEMPOTENT: two consecutive ticks against the same pinned
#      source both succeed. The script must hard-reset + clean the build
#      tree to the pinned base before applying the patch — a same-sha
#      `git checkout` is a no-op and would leave the previous run's applied
#      patch in the tree, making the second tick's `git apply --check`
#      fail (timer stops instead of reporting "already up to date").
#   6. The reset/clean target is ALWAYS the verified pinned 40-hex sha —
#      never a branch / origin/* ref (moving refs are refused at
#      resolve_ref AND must never reach checkout/reset).
#   7. An empty patch set is refused loudly — the script cannot silently
#      build an unpatched tree.
#
# Run: bash tests/shell/tap-update.test.sh   (any bash >= 3.2)
set -u
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SCRIPT="$ROOT/deploy/release/tap-update.sh"
BASH_MINOR="${BASH_VERSINFO[0]}.${BASH_VERSINFO[1]}"

fail() { echo "FAIL: $*" >&2; exit 1; }
ok() { echo "ok: $*"; }

[ -f "$SCRIPT" ] || fail "script not found: $SCRIPT"
bash -n "$SCRIPT" || fail "bash -n syntax check"

EXPECTED_DEFAULT_SHA="41278964ec8e3253e70d4e919dfb8e34211c543d"

# ---- resolve_ref (sourced function definitions; entrypoint removed) ----
defs="$(mktemp)"
sed '/^main "\$@"/d' "$SCRIPT" > "$defs"
cleanup_defs() { rm -f "$defs"; }
trap cleanup_defs EXIT

# Stubs shared by every full main() run: sudo (drop -u USER), go (fake
# build), systemctl, curl (healthy), install, flock, chown. Each test adds
# its own git stub on top (the git stub models the build-tree state that
# the test cares about).
install_common_stubs() {
  local TMP="$1"
  cat > "$TMP/stubs/sudo" <<'STUB'
#!/usr/bin/env bash
# sudo -u <user> <cmd...> -> run <cmd...>
shift 2
exec "$@"
STUB
  cat > "$TMP/stubs/go" <<'STUB'
#!/usr/bin/env bash
# go build -C DIR -o OUT ./cmd/tap
out=""
while [[ $# -gt 0 ]]; do
  if [[ "$1" == "-o" ]]; then out="$2"; shift 2; else shift; fi
done
echo "fake tap binary" > "$out"
chmod +x "$out"
exit 0
STUB
  cat > "$TMP/stubs/systemctl" <<'STUB'
#!/usr/bin/env bash
case "$1" in
  restart) exit "${SYSTEMCTL_RESTART_EXIT:-0}";;
esac
echo "systemctl stub unhandled: $*" >&2
exit 0
STUB
  cat > "$TMP/stubs/curl" <<'STUB'
#!/usr/bin/env bash
echo "200"
STUB
  cat > "$TMP/stubs/install" <<'STUB'
#!/usr/bin/env bash
# install -m 0755 SRC DST
cp "$3" "$4" || exit 1
chmod "$2" "$4" || exit 1
exit 0
STUB
  cat > "$TMP/stubs/flock" <<'STUB'
#!/usr/bin/env bash
exit 0
STUB
  cat > "$TMP/stubs/chown" <<'STUB'
#!/usr/bin/env bash
exit 0
STUB
  for s in "$TMP"/stubs/*; do chmod +x "$s"; done
}

# Stateful git stub: models a dedicated build tree whose worktree carries
# the applied patch between runs. `git checkout <sha>` does NOT clear an
# applied patch (a same-sha checkout is a no-op in real git); only
# `git reset --hard <sha>` + `git clean` restore the pinned base. The
# `apply --check` step fails while the patch is still applied — exactly
# the release blocker. Every invocation is logged to $GITSTATE/gitlog.
install_stateful_git_stub() {
  local TMP="$1"
  cat > "$TMP/stubs/git" <<'STUB'
#!/usr/bin/env bash
GITSTATE="${GITSTATE:?}"
log_line() { printf '%s\n' "$*" >> "$GITSTATE/gitlog"; }
sub=""
last=""
skip=0
for arg in "$@"; do
  if [[ $skip -eq 1 ]]; then skip=0; continue; fi   # value of -C <dir>
  if [[ -z "$sub" ]]; then
    case "$arg" in
      git) continue;;
      -C) skip=1; continue;;
      *) sub="$arg"; continue;;
    esac
  fi
  last="$arg"
done
case "$sub" in
  "rev-parse")
    case "$*" in
      *"--is-shallow-repository"*) echo false;;
      *"--verify"*) echo "${FIXED_SHA:?}";;
      *"HEAD"*) echo "${FIXED_SHA:?}";;
    esac
    exit 0;;
  "fetch")
    log_line "fetch"
    exit 0;;
  "reset")   # reset --hard --quiet <sha> — restore the pinned base
    log_line "reset:$last"
    rm -f "$GITSTATE/applied" "$GITSTATE/leftover"
    exit 0;;
  "clean")   # clean -fdx — drop untracked leftovers
    log_line "clean"
    rm -f "$GITSTATE/leftover"
    exit 0;;
  "checkout")   # same-sha checkout is a no-op: does NOT clear the patch
    log_line "checkout:$last"
    exit 0;;
  "apply")
    if [[ "$*" == *"--check"* ]]; then
      log_line "apply-check"
      if [[ -e "$GITSTATE/applied" ]]; then
        echo "stub: patch already applied to worktree" >&2
        exit 1
      fi
      exit 0
    fi
    log_line "apply"
    touch "$GITSTATE/applied"
    exit 0;;
esac
echo "git stub unhandled: $*" >&2
exit 0
STUB
  chmod +x "$TMP/stubs/git"
}

run_tap() {  # $1 = log file; env (build/bin/patch dirs) from caller
  GITSTATE="$TMP/gitstate" \
  FIXED_SHA="$EXPECTED_DEFAULT_SHA" \
  TAP_UPDATE_BUILD_DIR="$TMP/build" \
  TAP_UPDATE_TAP_BIN_DIR="$TMP/bin" \
  TAP_UPDATE_LOCK_FILE="$TMP/.updatelock" \
  TAP_UPDATE_PATCH_DIR="$TMP/patches" \
  TAP_UPDATE_PIN_FILE="$TMP/no-pin-file" \
  TAP_USER=tap TAP_GROUP=tap \
  PATH="$TMP/stubs:$PATH" \
  bash "$SCRIPT" > "$1" 2>&1
}

t1() {
  local out err
  err="$(mktemp)"
  out="$(TAP_UPDATE_PIN_FILE=/nonexistent TAP_UPDATE_DEFAULT_REF= bash -c '
    set -euo pipefail
    source "$1"
    resolve_ref
  ' _ "$defs" 2>"$err")"
  [[ "$out" == "$EXPECTED_DEFAULT_SHA" ]] || fail "resolve_ref stdout not the bare sha: got '$out'"
  grep -q "Default immutable base" "$err" || fail "resolve_ref diagnostics missing from stderr"
  rm -f "$err"
  ok "resolve_ref: stdout is exactly the default base sha, diagnostics on stderr"
}
t1

t2() {
  local pin out err
  pin="$(mktemp)"
  printf '  %s \n' "$EXPECTED_DEFAULT_SHA" > "$pin"   # whitespace-trimmed
  err="$(mktemp)"
  out="$(TAP_UPDATE_PIN_FILE="$pin" TAP_UPDATE_DEFAULT_REF= bash -c '
    set -euo pipefail
    source "$1"
    resolve_ref
  ' _ "$defs" 2>"$err")"
  rm -f "$pin" "$err"
  [[ "$out" == "$EXPECTED_DEFAULT_SHA" ]] || fail "pin-file resolve: got '$out'"
  ok "resolve_ref: pin file overrides the default, still bare sha on stdout"
}
t2

t3() {
  local pin err rc
  pin="$(mktemp)"
  printf 'origin/main\n' > "$pin"
  err="$(mktemp)"
  rc=0
  PIN_FILE="$pin" TAP_UPDATE_PIN_FILE="$pin" bash -c '
    set -euo pipefail
    source "$1"
    resolve_ref
  ' _ "$defs" >/dev/null 2> "$err" || rc=$?
  rm -f "$pin" "$err"
  [[ "$rc" -ne 0 ]] || fail "branch ref 'origin/main' must be refused"
  ok "resolve_ref: branch refs (origin/main) refused"
}
t3

# ---- full main() run: restart failure must roll back ----
t4() {
  local TMP
  TMP="$(mktemp -d)"
  mkdir -p "$TMP/build/.git" "$TMP/bin" "$TMP/patches" "$TMP/stubs" "$TMP/gitstate"
  echo "dummy patch body" > "$TMP/patches/0001-dummy.patch"
  # Previous install state: binary + recorded SHAs (rollback targets).
  echo "PREVIOUSBINARY" > "$TMP/bin/tap"
  chmod +x "$TMP/bin/tap"
  printf '1111111111111111111111111111111111111111\n' > "$TMP/bin/.version"
  printf 'OLD_PATCH_FP\n' > "$TMP/bin/.patches.sha256"
  printf 'OLDBINHASH\n' > "$TMP/bin/.binary.sha256"

  cat > "$TMP/stubs/git" <<'STUB'
#!/usr/bin/env bash
case "$*" in
  *"rev-parse --is-shallow-repository"*) echo false; exit 0;;
  *"rev-parse --verify"*) echo "${FIXED_SHA:?}"; exit 0;;
  *"rev-parse HEAD"*) echo "${FIXED_SHA:?}"; exit 0;;
  *"fetch"*) exit 0;;
  *"reset"*) exit 0;;
  *"clean"*) exit 0;;
  *"checkout"*) exit 0;;
  *"apply --check"*) exit 0;;
  *"apply"*) exit 0;;
esac
echo "git stub unhandled: $*" >&2
exit 0
STUB
  install_common_stubs "$TMP"

  local log rc
  log="$TMP/run.log"
  rc=0
  FIXED_SHA="$EXPECTED_DEFAULT_SHA" \
  SYSTEMCTL_RESTART_EXIT=1 \
  TAP_UPDATE_BUILD_DIR="$TMP/build" \
  TAP_UPDATE_TAP_BIN_DIR="$TMP/bin" \
  TAP_UPDATE_LOCK_FILE="$TMP/.updatelock" \
  TAP_UPDATE_PATCH_DIR="$TMP/patches" \
  TAP_UPDATE_PIN_FILE="$TMP/no-pin-file" \
  TAP_USER=tap TAP_GROUP=tap \
  PATH="$TMP/stubs:$PATH" \
  bash "$SCRIPT" > "$log" 2>&1 || rc=$?

  [[ "$rc" -eq 1 ]] || fail "restart-failure run should exit 1, got $rc"
  grep -q "systemctl restart tap FAILED — entering rollback" "$log" ||
    fail "expected restart-failure message, log: $(cat "$log")"
  grep -q "rollback restart FAILED — manual recovery required" "$log" ||
    fail "expected rollback-restart-failure message, log: $(cat "$log")"
  [[ "$(cat "$TMP/bin/tap")" == "PREVIOUSBINARY" ]] ||
    fail "previous binary not restored: $(cat "$TMP/bin/tap")"
  [[ "$(cat "$TMP/bin/.version")" == "1111111111111111111111111111111111111111" ]] ||
    fail "previous .version not restored: $(cat "$TMP/bin/.version")"
  [[ "$(cat "$TMP/bin/.patches.sha256")" == "OLD_PATCH_FP" ]] ||
    fail "previous .patches.sha256 not restored"
  [[ "$(cat "$TMP/bin/.binary.sha256")" == "OLDBINHASH" ]] ||
    fail "previous .binary.sha256 not restored"
  [[ -e "$TMP/bin/tap.prev" ]] && fail "tap.prev should be consumed by rollback"
  [[ -e "$TMP/bin/tap.new" ]] && fail "tap.new should be consumed by rollback"
  rm -rf "$TMP"
  ok "main(): failed restart enters rollback; previous binary + SHAs restored"
}
t4

# ---- main() idempotence: two consecutive ticks against the SAME pinned
# ---- source must both succeed. The second tick starts with the first
# ---- tick's applied patch still in the worktree (real git state); the
# ---- fixed script hard-resets + cleans to the pinned base first, so
# ---- `git apply --check` succeeds again and the tick short-circuits on
# ---- ".version + .patches.sha256 already match". reset/clean must only
# ---- ever target the pinned 40-hex sha, never a moving ref ----
t5() {
  local TMP
  TMP="$(mktemp -d)"
  mkdir -p "$TMP/build/.git" "$TMP/bin" "$TMP/patches" "$TMP/stubs" "$TMP/gitstate"
  echo "dummy patch body" > "$TMP/patches/0001-dummy.patch"
  ( cd "$TMP/gitstate" && : > gitlog )

  install_stateful_git_stub "$TMP"
  install_common_stubs "$TMP"

  local log1 log2 rc1 rc2
  log1="$TMP/run1.log"
  log2="$TMP/run2.log"
  rc1=0
  rc2=0

  # Seed a leftover untracked file in the build tree (e.g. an interrupted
  # build's tap-build-out) that only `git clean` removes.
  touch "$TMP/gitstate/leftover"

  run_tap "$log1" || rc1=$?
  [[ "$rc1" -eq 0 ]] || fail "tick 1 (pinned source) should succeed, rc=$rc1; log: $(cat "$log1")"
  grep -q "Installing" "$log1" || fail "tick 1 should build+install, log: $(cat "$log1")"
  grep -q "✅ TAP updated" "$log1" || fail "tick 1 should complete the update, log: $(cat "$log1")"
  [[ -e "$TMP/gitstate/applied" ]] || fail "tick 1 should leave the patched worktree (run-2 precondition)"
  [[ -e "$TMP/gitstate/leftover" ]] && fail "tick 1's clean must drop untracked leftovers"

  run_tap "$log2" || rc2=$?
  [[ "$rc2" -eq 0 ]] || fail "tick 2 (same pinned source + applied patch in tree) must succeed — the previous patch must be reset+cleaned before re-apply, rc=$rc2; log: $(cat "$log2")"
  grep -q "Already on ${EXPECTED_DEFAULT_SHA:0:12}" "$log2" ||
    fail "tick 2 should short-circuit 'Already on', log: $(cat "$log2")"
  grep -q "nothing to do" "$log2" || fail "tick 2 short-circuit message missing, log: $(cat "$log2")"
  grep -q "Installing" "$log2" && fail "tick 2 must NOT rebuild after the already-on short circuit"
  grep -q "does NOT apply cleanly" "$log2" &&
    fail "tick 2 apply --check must succeed (patch was reset+cleaned), log: $(cat "$log2")"
  grep -q "Entering rollback" "$log2" && fail "tick 2 must not roll back"

  local resets cleans checks checkouts allresets
  resets="$(grep -c "^reset:$EXPECTED_DEFAULT_SHA$" "$TMP/gitstate/gitlog" || true)"
  cleans="$(grep -c "^clean$" "$TMP/gitstate/gitlog" || true)"
  checks="$(grep -c "^apply-check$" "$TMP/gitstate/gitlog" || true)"
  checkouts="$(grep -c "^checkout:" "$TMP/gitstate/gitlog" || true)"
  allresets="$(grep -c '^reset:' "$TMP/gitstate/gitlog" || true)"
  [[ "$resets" -eq 2 ]] || fail "expected 2 resets to the pinned base, got $resets; gitlog: $(cat "$TMP/gitstate/gitlog")"
  [[ "$allresets" -eq 2 ]] || fail "every reset must target the pinned sha (got $allresets reset lines); gitlog: $(cat "$TMP/gitstate/gitlog")"
  [[ "$cleans" -eq 2 ]] || fail "expected 2 cleans, got $cleans; gitlog: $(cat "$TMP/gitstate/gitlog")"
  [[ "$checks" -eq 2 ]] || fail "expected 2 apply --check (both passing), got $checks; gitlog: $(cat "$TMP/gitstate/gitlog")"
  [[ "$checkouts" -eq 0 ]] || fail "the fixed script must reset/clean, not checkout ($checkouts checkout(s)); gitlog: $(cat "$TMP/gitstate/gitlog")"
  grep -qE '^reset:(origin|refs/|[^0-9a-f])' "$TMP/gitstate/gitlog" &&
    fail "reset must never target a moving ref; gitlog: $(cat "$TMP/gitstate/gitlog")"
  grep -q "origin" "$TMP/gitstate/gitlog" && fail "moving refs must never reach git at all"

  rm -rf "$TMP"
  ok "main(): two identical ticks against the same pinned source both succeed (reset+clean to pinned base; tick 2 = already-on no-op)"
}
t5

# ---- main() refuses to build an UNPATCHED tree: empty patch set ----
t6() {
  local TMP
  TMP="$(mktemp -d)"
  mkdir -p "$TMP/build/.git" "$TMP/bin" "$TMP/patches" "$TMP/stubs" "$TMP/gitstate"
  # NOTE: $TMP/patches has NO *.patch files.

  install_stateful_git_stub "$TMP"
  install_common_stubs "$TMP"

  local log rc
  log="$TMP/run.log"
  rc=0
  run_tap "$log" || rc=$?

  [[ "$rc" -eq 1 ]] || fail "empty patch set must exit 1, got rc=$rc; log: $(cat "$log")"
  grep -q "refusing to build unpatched TAP" "$log" ||
    fail "expected unpatched-tree refusal message, log: $(cat "$log")"
  grep -q "Installing" "$log" && fail "must never install when the patch set is empty"
  grep -q "nothing to do" "$log" && fail "must never report already-on with an empty patch set"
  rm -rf "$TMP"
  ok "main(): empty patch set refused loudly (cannot silently build an unpatched tree)"
}
t6

# ---- apply_patches: the patch fingerprint must be staged via mktemp (a
# ---- predictable /tmp/tap-patches.sha256 written as ROOT is a symlink-
# ---- clobber primitive), land in TAP_BIN_DIR/.patches.sha256.new with the
# ---- exact sorted sha256sum content, and leave no temp litter behind ----
t7() {
  local TMP
  TMP="$(mktemp -d)"
  mkdir -p "$TMP/patches" "$TMP/bin" "$TMP/stubs" "$TMP/gitstate" "$TMP/tmpdir"
  printf 'this is a fingerprinted patch body\n' > "$TMP/patches/0001-a.patch"
  # Attack primitive: a pre-existing predictable /tmp/tap-patches.sha256
  # symlink pointing at a root-writable victim file. A `>` redirect would
  # follow it and clobber the victim; mktemp staging must not.
  local victim
  victim="$TMP/victim.txt"
  echo "PRECIOUS" > "$victim"
  ln -s "$victim" /tmp/tap-patches.sha256
  install_stateful_git_stub "$TMP"
  install_common_stubs "$TMP"

  local log rc
  log="$TMP/run.log"
  rc=0
  GITSTATE="$TMP/gitstate" \
  FIXED_SHA="$EXPECTED_DEFAULT_SHA" \
  TAP_UPDATE_BUILD_DIR="$TMP/build" \
  TAP_UPDATE_TAP_BIN_DIR="$TMP/bin" \
  TAP_UPDATE_PATCH_DIR="$TMP/patches" \
  TMPDIR="$TMP/tmpdir" \
  TAP_USER=tap TAP_GROUP=tap \
  PATH="$TMP/stubs:$PATH" \
  bash -c '
    set -euo pipefail
    source "$1"
    apply_patches
  ' _ "$defs" > "$log" 2>&1 || rc=$?

  [[ "$rc" -eq 0 ]] || fail "apply_patches should succeed, rc=$rc; log: $(cat "$log")"
  local expected
  expected="$( ( cd "$TMP/patches" && sha256sum ./*.patch ) | sort -k2 )"
  [[ -f "$TMP/bin/.patches.sha256.new" ]] ||
    fail ".patches.sha256.new missing; log: $(cat "$log")"
  [[ "$(cat "$TMP/bin/.patches.sha256.new")" == "$expected" ]] ||
    fail ".patches.sha256.new fingerprint mismatch: got '$(cat "$TMP/bin/.patches.sha256.new")' want '$expected'"
  [[ "$(cat "$victim")" != "PRECIOUS" ]] &&
    fail "predictable /tmp/tap-patches.sha256 symlink was FOLLOWED (victim clobbered)"
  # The planted symlink must still be the symlink — the fixed script never
  # opens/moves the predictable path; mktemp stages elsewhere. (The old
  # script's `>` followed it AND its `mv` consumed the symlink itself.)
  [[ "$(readlink /tmp/tap-patches.sha256)" == "$victim" ]] ||
    fail "predictable /tmp/tap-patches.sha256 was consumed by the script"
  rm -f /tmp/tap-patches.sha256
  [[ -z "$(ls -A "$TMP/tmpdir" 2>/dev/null)" ]] ||
    fail "mktemp staging file must be consumed/cleaned; leftover: $(ls -A "$TMP/tmpdir")"
  rm -rf "$TMP"
  ok "apply_patches: fingerprint staged via mktemp (no predictable /tmp file), .new lands correctly, temp cleaned"
}
t7

# ---- tap.db group-write: drift-alert (kipclip user, SupplementaryGroups=tap)
# ---- deletes quarantined TAP repo rows in tap.db. tap-update must enforce
# ---- tap:tap 2770 on the data dir (setgid -> a recreated tap.db keeps group
# ---- tap) and 0660 on the db FILE — never any world bit — idempotently ----
t8() {
  local TMP
  TMP="$(mktemp -d)"
  mkdir -p "$TMP/stubs" "$TMP/tap"
  echo "SQLITE" > "$TMP/tap/tap.db"
  install_common_stubs "$TMP"

  cat > "$TMP/stubs/chmod" <<'STUB'
#!/usr/bin/env bash
echo "chmod $*" >> "${TMP:?}/permlog"
exit 0
STUB
  cat > "$TMP/stubs/chown" <<'STUB'
#!/usr/bin/env bash
echo "chown $*" >> "${TMP:?}/permlog"
exit 0
STUB
  chmod +x "$TMP/stubs/chmod" "$TMP/stubs/chown"

  run_ensure() {  # $1 = TAP_UPDATE_TAP_DB_PATH
    local rc=0
    TMP="$TMP" \
    TAP_UPDATE_TAP_DB_PATH="$1" \
    PATH="$TMP/stubs:$PATH" \
    bash -c '
      set -euo pipefail
      source "$1"
      ensure_tap_db_group_write
      echo "rc=$?"
    ' _ "$defs" >/dev/null 2>&1 || rc=$?
    return "$rc"
  }

  run_ensure "$TMP/tap/tap.db" || fail "group-write enforcement should succeed"
  [[ "$(grep -c '^chown tap:tap '"$TMP/tap"'$' "$TMP/permlog")" -eq 1 ]] ||
    fail "data dir must be chown'd to tap:tap: $(cat "$TMP/permlog")"
  [[ "$(grep -c '^chown tap:tap '"$TMP/tap/tap.db"'$' "$TMP/permlog")" -eq 1 ]] ||
    fail "tap.db must be chown'd to tap:tap: $(cat "$TMP/permlog")"
  [[ "$(grep -c '^chmod 2770 '"$TMP/tap"'$' "$TMP/permlog")" -eq 1 ]] ||
    fail "data dir must be chmod 2770 (setgid + group rwx, no world): $(cat "$TMP/permlog")"
  [[ "$(grep -c '^chmod 0660 '"$TMP/tap/tap.db"'$' "$TMP/permlog")" -eq 1 ]] ||
    fail "tap.db must be chmod 0660 (group rw, no world): $(cat "$TMP/permlog")"
  grep -qE '^chmod (0666|0777|1777|0644|0755|0664) ' "$TMP/permlog" &&
    fail "forbidden world-visible mode used: $(cat "$TMP/permlog")"
  grep -qE '^chown (root|nobody|daemon)' "$TMP/permlog" &&
    fail "ownership must stay tap:tap: $(cat "$TMP/permlog")"

  # Idempotent: a second pass re-asserts the same modes without error.
  run_ensure "$TMP/tap/tap.db" || fail "second enforcement pass should succeed"
  [[ "$(grep -c '^chmod 2770 '"$TMP/tap"'$' "$TMP/permlog")" -eq 2 ]] ||
    fail "enforcement must be idempotent (dir chmod 2770 twice): $(cat "$TMP/permlog")"

  # Missing data dir (fresh box before TAP first run): skip, exit 0, no chmod/chown.
  local before
  before="$(grep -c '^chmod ' "$TMP/permlog")"
  run_ensure "$TMP/does-not-exist/tap.db" || fail "missing dir must skip cleanly"
  [[ "$(grep -c '^chmod ' "$TMP/permlog")" == "$before" ]] ||
    fail "missing dir must not chmod anything: $(cat "$TMP/permlog")"

  rm -rf "$TMP"
  ok "ensure_tap_db_group_write: tap:tap 2770 dir / 0660 db, never world-writable, idempotent, missing-dir skip"
}
t8

# ---- apply_patches: after atomic staging the temporary-file RETURN trap must
# ---- be cleared. The temp name is consumed by the mv, so a stale
# ---- `trap 'rm -f -- "$FP_TMP"' RETURN` left installed would fire as a
# ---- harmless no-op on every later function return — still a stale trap.
t9() {
  local TMP
  TMP="$(mktemp -d)"
  mkdir -p "$TMP/patches" "$TMP/bin" "$TMP/stubs" "$TMP/gitstate" "$TMP/tmpdir"
  printf 'fingerprinted patch body\n' > "$TMP/patches/0001-a.patch"
  install_stateful_git_stub "$TMP"
  install_common_stubs "$TMP"

  local log rc
  log="$TMP/run.log"
  rc=0
  GITSTATE="$TMP/gitstate" \
  FIXED_SHA="$EXPECTED_DEFAULT_SHA" \
  TAP_UPDATE_BUILD_DIR="$TMP/build" \
  TAP_UPDATE_TAP_BIN_DIR="$TMP/bin" \
  TAP_UPDATE_PATCH_DIR="$TMP/patches" \
  TMPDIR="$TMP/tmpdir" \
  TAP_USER=tap TAP_GROUP=tap \
  PATH="$TMP/stubs:$PATH" \
  bash -c '
    set -euo pipefail
    source "$1"
    apply_patches
    # The fixed script clears the RETURN trap after atomic staging. A stale
    # trap here would print `trap -- ... RETURN`.
    if [[ -n "$(trap -p RETURN)" ]]; then
      echo "stale RETURN trap still installed after apply_patches: $(trap -p RETURN)" >&2
      exit 1
    fi
  ' _ "$defs" > "$log" 2>&1 || rc=$?

  [[ "$rc" -eq 0 ]] || fail "apply_patches must clear its RETURN trap, rc=$rc; log: $(cat "$log")"
  rm -rf "$TMP"
  ok "apply_patches: temporary-file RETURN trap cleared after atomic staging (no stale trap on later returns)"
}
t9

# ---- main() repairs ownership of the DEDICATED build tree BEFORE any
# ---- `sudo -u tap git -C $BUILD_DIR` operation. Real git refuses to run
# ---- in a repository it does not own (`fatal: detected dubious ownership
# ---- in repository at ...`) and a root-owned checkout is also unwritable
# ---- by tap — the production tap-update failure that started this fix.
# ---- The regression starts from a "root-owned" build tree. The harness
# ---- runs as a non-root user (can't chown the fake tree for real), so the
# ---- git stub models git's own safety gate: while the tree is marked
# ---- root-owned it answers EVERY invocation with git's exact fatal error
# ---- and exit 128, exactly like real git on a root-owned repo — no
# ---- safe.directory/config weakening involved. The script must chown the
# ---- tree to tap:tap (marker cleared by the chown stub) before any git
# ---- op succeeds; the fake build dir is additionally seeded non-writable
# ---- to prove the writability repair (chmod -R u+rwX) is emitted too.
# ---- The immutable-sha pinning / no-moving-refs / patch-refusal guarantees
# ---- from t5/t6 must all still hold on the repaired tree.
t10() {
  # Scenario A: one full tick from a root-owned build tree.
  local TA log rc
  TA="$(mktemp -d)"
  TMP="$TA"
  mkdir -p "$TA/build/.git" "$TA/bin" "$TA/patches" "$TA/stubs" "$TA/gitstate"
  echo "dummy patch body" > "$TA/patches/0001-dummy.patch"
  ( cd "$TA/gitstate" && : > gitlog )
  # Simulated root-owned starting state. The real dir must stay writable —
  # the fake `go build` stub writes tap-build-out into it as an unprivileged
  # user — so the ownership contract lives in the git gate below (which
  # models git's st_uid check, the only thing git itself consults); the
  # chmod -R u+rwX writability repair is asserted via the permlog.
  touch "$TA/gitstate/root-owned"

  install_common_stubs "$TA"
  # Overwrite the stateful git stub with an ownership-gated variant.
  cat > "$TA/stubs/git" <<'STUB'
#!/usr/bin/env bash
GITSTATE="${GITSTATE:?}"
# Model git's own safety gate exactly: while the build tree is still
# root-owned, EVERY git invocation dies with git's real error + exit 128.
if [[ -e "$GITSTATE/root-owned" ]]; then
  echo "fatal: detected dubious ownership in repository at '${TAP_UPDATE_BUILD_DIR:-?}'" >&2
  exit 128
fi
log_line() { printf '%s\n' "$*" >> "$GITSTATE/gitlog"; }
sub=""
last=""
skip=0
for arg in "$@"; do
  if [[ $skip -eq 1 ]]; then skip=0; continue; fi
  if [[ -z "$sub" ]]; then
    case "$arg" in
      git) continue;;
      -C) skip=1; continue;;
      *) sub="$arg"; continue;;
    esac
  fi
  last="$arg"
done
case "$sub" in
  "rev-parse")
    case "$*" in
      *"--is-shallow-repository"*) echo false;;
      *"--verify"*) echo "${FIXED_SHA:?}";;
      *"HEAD"*) echo "${FIXED_SHA:?}";;
    esac
    exit 0;;
  "fetch")
    log_line "fetch"
    exit 0;;
  "reset")
    log_line "reset:$last"
    rm -f "$GITSTATE/applied" "$GITSTATE/leftover"
    exit 0;;
  "clean")
    log_line "clean"
    rm -f "$GITSTATE/leftover"
    exit 0;;
  "checkout")
    log_line "checkout:$last"
    exit 0;;
  "apply")
    if [[ "$*" == *"--check"* ]]; then
      log_line "apply-check"
      if [[ -e "$GITSTATE/applied" ]]; then
        echo "stub: patch already applied to worktree" >&2
        exit 1
      fi
      if [[ -e "$GITSTATE/apply-check-fail" ]]; then
        echo "stub: apply-check forced to fail (source drift)" >&2
        exit 1
      fi
      exit 0
    fi
    log_line "apply"
    touch "$GITSTATE/applied"
    exit 0;;
esac
echo "git stub unhandled: $*" >&2
exit 0
STUB
  # Ownership/writability repair stubs: log the exact chown/chmod lines and
  # clear the root-owned gate ONLY when the DEDICATED build tree is chown'd
  # (-R ... <dir> ending in /build) — the tap.db group-write chowns must
  # never clear it. permlog lives in gitstate (GITSTATE is exported by
  # run_tap; the test env's TMP is not).
  cat > "$TA/stubs/chown" <<'STUB'
#!/usr/bin/env bash
echo "chown $*" >> "${GITSTATE:?}/permlog"
if [[ "$1" == "-R" && "$*" == */build ]]; then
  rm -f "$GITSTATE/root-owned"
  touch "$GITSTATE/ownership-repaired"
fi
exit 0
STUB
  cat > "$TA/stubs/chmod" <<'STUB'
#!/usr/bin/env bash
# Apply for real (the fake `go build` output must become executable) AND
# record the exact mode call for the permlog assertions. The stub dir is
# first in PATH, so invoke the REAL chmod explicitly (@REAL_CHMOD@ is
# substituted at stub-write time; an unqualified `chmod` here would recurse
# into this stub until fork fails).
@REAL_CHMOD@ "$@" || exit 1
echo "chmod $*" >> "${GITSTATE:?}/permlog"
exit 0
STUB
  # Resolve the real chmod from the HARNESS PATH (stubs not yet present)
  # and substitute it into the stub body.
  local REAL_CHMOD
  REAL_CHMOD="$(command -v chmod)"
  sed -i '' "s|@REAL_CHMOD@|$REAL_CHMOD|" "$TA/stubs/chmod"
  chmod +x "$TA/stubs/git" "$TA/stubs/chown" "$TA/stubs/chmod"

  log="$TA/run.log"
  rc=0
  run_tap "$log" || rc=$?

  [[ "$rc" -eq 0 ]] || fail "tick from a root-owned build tree must repair ownership first and succeed, rc=$rc; log: $(cat "$log")"
  grep -q "✅ TAP updated" "$log" || fail "full update should complete after ownership repair; log: $(cat "$log")"
  grep -q "detected dubious ownership" "$log" &&
    fail "no git op may run while the tree is still root-owned; log: $(cat "$log")"
  [[ -e "$TA/gitstate/ownership-repaired" ]] ||
    fail "script must chown the build tree to tap:tap before any git op (ownership-repaired marker missing); log: $(cat "$log")"
  [[ ! -e "$TA/gitstate/root-owned" ]] ||
    fail "root-owned gate must be cleared by the ownership repair; log: $(cat "$log")"
  [[ "$(grep -c '^chown -R tap:tap '"$TA/build"'$' "$TA/gitstate/permlog")" -eq 1 ]] ||
    fail "build tree must be chown -R'd to tap:tap: $(cat "$TA/gitstate/permlog")"
  [[ "$(grep -c '^chmod -R u+rwX '"$TA/build"'$' "$TA/gitstate/permlog")" -eq 1 ]] ||
    fail "build tree must be chmod -R u+rwX'd (owner-writable): $(cat "$TA/gitstate/permlog")"
  # Ordering proof: the git gate hard-refuses every git op while root-owned,
  # so the FIRST successful git op in the log can only exist AFTER the
  # ownership repair — it must be the fetch, never a reset/apply.
  [[ -s "$TA/gitstate/gitlog" ]] || fail "expected git ops after ownership repair; gitlog empty"
  [[ "$(head -1 "$TA/gitstate/gitlog")" == "fetch" ]] ||
    fail "first git op must come AFTER the ownership repair (fetch expected, got: $(head -1 "$TA/gitstate/gitlog")); gitlog: $(cat "$TA/gitstate/gitlog")"
  # No-moving-refs / immutable-sha pinning on the repaired tree (t5 greps).
  [[ "$(grep -c '^reset:'"$EXPECTED_DEFAULT_SHA"'$' "$TA/gitstate/gitlog")" -eq 1 ]] ||
    fail "expected exactly 1 reset to the pinned base, gitlog: $(cat "$TA/gitstate/gitlog")"
  [[ "$(grep -c '^reset:' "$TA/gitstate/gitlog")" -eq 1 ]] ||
    fail "every reset must target the pinned sha, gitlog: $(cat "$TA/gitstate/gitlog")"
  [[ "$(grep -c '^clean$' "$TA/gitstate/gitlog")" -eq 1 ]] ||
    fail "expected 1 clean, gitlog: $(cat "$TA/gitstate/gitlog")"
  [[ "$(grep -c '^apply-check$' "$TA/gitstate/gitlog")" -eq 1 ]] ||
    fail "expected 1 apply --check (passing), gitlog: $(cat "$TA/gitstate/gitlog")"
  [[ "$(grep -c '^checkout:' "$TA/gitstate/gitlog")" -eq 0 ]] ||
    fail "the fixed script must reset/clean, not checkout; gitlog: $(cat "$TA/gitstate/gitlog")"
  grep -q "origin" "$TA/gitstate/gitlog" && fail "moving refs must never reach git at all"
  rm -rf "$TA"
  ok "main(): root-owned build tree is chown'd to tap:tap before the first git op; full tick succeeds with pinned-sha reset/clean + patch apply, no moving refs"

  # Scenario B: same root-owned start, but the patch does NOT apply on the
  # (repaired) tree — the build must be REFUSED loudly, never silently
  # unpatched, even after the ownership repair ran first.
  local TB logB rcB
  TB="$(mktemp -d)"
  TMP="$TB"
  mkdir -p "$TB/build/.git" "$TB/bin" "$TB/patches" "$TB/stubs" "$TB/gitstate"
  echo "dummy patch body" > "$TB/patches/0001-dummy.patch"
  ( cd "$TB/gitstate" && : > gitlog )
  touch "$TB/gitstate/root-owned" "$TB/gitstate/apply-check-fail"

  install_common_stubs "$TB"
  # Overwrite with the ownership-gated git stub (refusal variant).
  cat > "$TB/stubs/git" <<'STUB'
#!/usr/bin/env bash
GITSTATE="${GITSTATE:?}"
if [[ -e "$GITSTATE/root-owned" ]]; then
  echo "fatal: detected dubious ownership in repository at '${TAP_UPDATE_BUILD_DIR:-?}'" >&2
  exit 128
fi
log_line() { printf '%s\n' "$*" >> "$GITSTATE/gitlog"; }
sub=""
last=""
skip=0
for arg in "$@"; do
  if [[ $skip -eq 1 ]]; then skip=0; continue; fi
  if [[ -z "$sub" ]]; then
    case "$arg" in
      git) continue;;
      -C) skip=1; continue;;
      *) sub="$arg"; continue;;
    esac
  fi
  last="$arg"
done
case "$sub" in
  "rev-parse")
    case "$*" in
      *"--is-shallow-repository"*) echo false;;
      *"--verify"*) echo "${FIXED_SHA:?}";;
      *"HEAD"*) echo "${FIXED_SHA:?}";;
    esac
    exit 0;;
  "fetch")
    log_line "fetch"
    exit 0;;
  "reset")
    log_line "reset:$last"
    exit 0;;
  "clean")
    log_line "clean"
    exit 0;;
  "checkout")
    log_line "checkout:$last"
    exit 0;;
  "apply")
    log_line "apply-check"
    echo "stub: apply-check forced to fail (source drift)" >&2
    exit 1;;
esac
echo "git stub unhandled: $*" >&2
exit 0
STUB
  cat > "$TB/stubs/chown" <<'STUB'
#!/usr/bin/env bash
echo "chown $*" >> "${GITSTATE:?}/permlog"
if [[ "$1" == "-R" && "$*" == */build ]]; then
  rm -f "$GITSTATE/root-owned"
  touch "$GITSTATE/ownership-repaired"
fi
exit 0
STUB
  cat > "$TB/stubs/chmod" <<'STUB'
#!/usr/bin/env bash
@REAL_CHMOD@ "$@" || exit 1
echo "chmod $*" >> "${GITSTATE:?}/permlog"
exit 0
STUB
  local REAL_CHMOD
  REAL_CHMOD="$(command -v chmod)"
  sed -i '' "s|@REAL_CHMOD@|$REAL_CHMOD|" "$TB/stubs/chmod"
  chmod +x "$TB/stubs/git" "$TB/stubs/chown" "$TB/stubs/chmod"

  logB="$TB/run.log"
  rcB=0
  run_tap "$logB" || rcB=$?

  [[ "$rcB" -eq 1 ]] || fail "root-owned tree + non-applying patch must exit 1, rc=$rcB; log: $(cat "$logB")"
  grep -q "does NOT apply cleanly" "$logB" ||
    fail "patch refusal must still fire after ownership repair, log: $(cat "$logB")"
  grep -q "Installing" "$logB" && fail "must never install when the patch does not apply"
  [[ -e "$TB/gitstate/ownership-repaired" ]] ||
    fail "ownership repair must run even when the patch later fails; log: $(cat "$logB")"
  [[ "$(head -1 "$TB/gitstate/gitlog")" == "fetch" ]] ||
    fail "ownership repair must precede git ops even on the refusal path; gitlog: $(cat "$TB/gitstate/gitlog")"
  rm -rf "$TB"
  ok "main(): root-owned tree repaired first, THEN patch refusal fires loudly (no unpatched build, no moving refs)"
}
t10

echo
echo "ALL TAP-UPDATE SHELL TESTS PASSED (bash $BASH_MINOR)"