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
  ' _ "$defs" >/dev/null 2>"$err" || rc=$?
  rm -f "$pin" "$err"
  [[ "$rc" -ne 0 ]] || fail "branch ref 'origin/main' must be refused"
  ok "resolve_ref: branch refs (origin/main) refused"
}
t3

# ---- full main() run: restart failure must roll back ----
t4() {
  local TMP
  TMP="$(mktemp -d)"
  mkdir -p "$TMP/build/.git" "$TMP/bin" "$TMP/patches" "$TMP/stubs"
  echo "dummy patch body" > "$TMP/patches/0001-dummy.patch"
  # Previous install state: binary + recorded SHAs (rollback targets).
  echo "PREVIOUSBINARY" > "$TMP/bin/tap"
  chmod +x "$TMP/bin/tap"
  printf '1111111111111111111111111111111111111111\n' > "$TMP/bin/.version"
  printf 'OLD_PATCH_FP\n' > "$TMP/bin/.patches.sha256"
  printf 'OLDBINHASH\n' > "$TMP/bin/.binary.sha256"

  # ---- stub tools ----
  cat > "$TMP/stubs/git" <<'STUB'
#!/usr/bin/env bash
case "$*" in
  *"rev-parse --is-shallow-repository"*) echo false; exit 0;;
  *"rev-parse --verify"*) echo "${FIXED_SHA:?}"; exit 0;;
  *"rev-parse HEAD"*) echo "${FIXED_SHA:?}"; exit 0;;
  *"fetch"*) exit 0;;
  *"checkout"*) exit 0;;
  *"apply --check"*) exit 0;;
  *"apply"*) exit 0;;
esac
echo "git stub unhandled: $*" >&2
exit 0
STUB
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
echo "000"
STUB
  cat > "$TMP/stubs/install" <<'STUB'
#!/usr/bin/env bash
# install -m 0755 SRC DST
cp "$3" "$4" || exit 1
chmod "$2" "$4" || exit 1
exit 0
STUB
  cat > "$TMP/stubs/sha256sum" <<'STUB'
#!/usr/bin/env bash
for f in "$@"; do
  echo "0000000000000000000000000000000000000000000000000000000000000000  $f"
done
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

  local log rc
  log="$TMP/run.log"
  rc=0
  SYSTEMCTL_RESTART_EXIT=1 \
  FIXED_SHA="$EXPECTED_DEFAULT_SHA" \
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

echo
echo "ALL TAP-UPDATE SHELL TESTS PASSED (bash $BASH_MINOR)"