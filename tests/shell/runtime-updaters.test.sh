#!/usr/bin/env bash
# Real updater entrypoints with isolated binaries, network/systemd stubs, and
# process-kill fault injection. No host services, installs, or downloads.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SUITE_TMP="$(mktemp -d)"
trap 'rm -rf "$SUITE_TMP"' EXIT
fail() { echo "FAIL: $*" >&2; [[ ! -f "${CASE_DIR:-}/run.log" ]] || cat "$CASE_DIR/run.log" >&2; exit 1; }

setup_case() {
  KIND="$1"
  CASE_DIR="$(mktemp -d "$SUITE_TMP/$KIND.XXXXXX")"
  mkdir -p "$CASE_DIR/bin" "$CASE_DIR/build/.git" "$CASE_DIR/patches" "$CASE_DIR/stubs"
  ACTIVE_BIN="$CASE_DIR/bin/$KIND"
  printf '#!/usr/bin/env bash\n# previous\necho "deno 2.7.1"\n' > "$ACTIVE_BIN"
  chmod +x "$ACTIVE_BIN"
  if [[ "$KIND" == tap ]]; then
    printf '1111111111111111111111111111111111111111\n' > "$CASE_DIR/bin/.version"
    # Preserve absence and empty files too, not stale optional .prev content.
    : > "$CASE_DIR/bin/.binary.sha256"
    echo stale > "$CASE_DIR/bin/.patches.sha256.prev"
    echo patch > "$CASE_DIR/patches/0001.patch"
  fi
  cp "$ACTIVE_BIN" "$CASE_DIR/previous"
  TXN="$CASE_DIR/bin/.$KIND-update-txn"
  cat > "$CASE_DIR/stubs/systemctl" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$CASE_DIR/systemctl.log"
if [[ "${CRASH_RESTART:-0}" == 1 && ! -e "$CASE_DIR/crashed" ]]; then
  touch "$CASE_DIR/crashed"
  kill -KILL "$PPID"
fi
if [[ "${RESTART_FAIL:-}" == all ]] || { [[ "${RESTART_FAIL:-}" == candidate ]] && grep -q '# candidate' "$ACTIVE_BIN"; }; then exit 1; fi
STUB
  cat > "$CASE_DIR/stubs/mv" <<'STUB'
#!/usr/bin/env bash
/bin/mv "$@" || exit 1
last=""
for last in "$@"; do :; done
if [[ "${CRASH_SWAP:-0}" == 1 && "$last" == "$ACTIVE_BIN" && ! -e "$CASE_DIR/crashed" ]]; then
  touch "$CASE_DIR/crashed"
  kill -KILL "$PPID"
fi
STUB
  cat > "$CASE_DIR/stubs/curl" <<'STUB'
#!/usr/bin/env bash
out=""; url=""
while [[ $# -gt 0 ]]; do
  case "$1" in -o) out="$2"; shift 2;; *) url="$1"; shift;; esac
done
case "$url" in
  *release-latest.txt) echo fetched >> "$CASE_DIR/fetch.log"; echo v2.7.2;;
  *.sha256sum) (cd "$(dirname "$out")" && sha256sum "$(basename "${out%.sha256sum}")") > "$out";;
  *.zip) echo archive > "$out";;
  http://127.0.0.1:*)
    if [[ "${HEALTH_FAIL:-}" == all ]] || { [[ "${HEALTH_FAIL:-}" == candidate ]] && grep -q '# candidate' "$ACTIVE_BIN"; }; then exit 1; fi
    echo 200;;
  *) echo "Unexpected curl: $url" >&2; exit 1;;
esac
STUB
  cat > "$CASE_DIR/stubs/unzip" <<'STUB'
#!/usr/bin/env bash
while [[ "$1" != -d ]]; do shift; done
printf '#!/usr/bin/env bash\n# candidate\necho "deno 2.7.2"\n' > "$2/deno"
chmod +x "$2/deno"
STUB
  cat > "$CASE_DIR/stubs/git" <<'STUB'
#!/usr/bin/env bash
case "$*" in
  *--is-shallow-repository*) echo false;;
  *rev-parse*) echo 41278964ec8e3253e70d4e919dfb8e34211c543d;;
  *fetch*) echo fetched >> "$CASE_DIR/fetch.log";;
esac
STUB
  cat > "$CASE_DIR/stubs/go" <<'STUB'
#!/usr/bin/env bash
while [[ "$1" != -o ]]; do shift; done
printf '#!/usr/bin/env bash\n# candidate\n' > "$2"
chmod +x "$2"
STUB
  cat > "$CASE_DIR/stubs/sudo" <<'STUB'
#!/usr/bin/env bash
shift 2
exec "$@"
STUB
  cat > "$CASE_DIR/stubs/sync" <<'STUB'
#!/usr/bin/env bash
if [[ "${SYNC_FAIL:-0}" == 1 ]]; then exit 1; fi
STUB
  for name in flock chown sleep; do
    printf '#!/usr/bin/env bash\nexit 0\n' > "$CASE_DIR/stubs/$name"
  done
  chmod +x "$CASE_DIR"/stubs/*
}

run_case() {
  # Keep the outer shell strict; capture only the external process exit status.
  RC=0
  env CASE_DIR="$CASE_DIR" ACTIVE_BIN="$ACTIVE_BIN" \
    PATH="$CASE_DIR/stubs:$PATH" \
    DENO_UPDATE_BIN_DIR="$CASE_DIR/bin" DENO_UPDATE_LOCK_FILE="$CASE_DIR/lock" \
    DENO_UPDATE_PIN_FILE="$CASE_DIR/no-pin" \
    TAP_UPDATE_BUILD_DIR="$CASE_DIR/build" TAP_UPDATE_TAP_BIN_DIR="$CASE_DIR/bin" \
    TAP_UPDATE_LOCK_FILE="$CASE_DIR/lock" TAP_UPDATE_PIN_FILE="$CASE_DIR/no-pin" \
    TAP_UPDATE_DEFAULT_REF=41278964ec8e3253e70d4e919dfb8e34211c543d \
    TAP_UPDATE_PATCH_DIR="$CASE_DIR/patches" TAP_UPDATE_TAP_DB_PATH="$CASE_DIR/no-db/db" \
    "$@" bash "$ROOT/deploy/release/$KIND-update.sh" > "$CASE_DIR/run.log" 2>&1 || RC=$?
}
assert_previous() {
  cmp -s "$ACTIVE_BIN" "$CASE_DIR/previous" || fail "$KIND previous binary not restored"
  if [[ "$KIND" == tap ]]; then
    [[ "$(cat "$CASE_DIR/bin/.version")" == 1111111111111111111111111111111111111111 ]] || fail "previous source not restored"
    [[ ! -e "$CASE_DIR/bin/.patches.sha256" ]] || fail "absent provenance restored from stale .prev"
    [[ -f "$CASE_DIR/bin/.binary.sha256" && ! -s "$CASE_DIR/bin/.binary.sha256" ]] || fail "empty provenance not preserved"
  fi
}
assert_recovery() {
  run_case
  [[ "$RC" == 0 && ! -e "$TXN" ]] || fail "$KIND next-tick recovery failed"
  grep -q 'Recovering interrupted' "$CASE_DIR/run.log" || fail "recovery path missing"
  assert_previous
}

for KIND in deno tap; do
  bash -n "$ROOT/deploy/release/$KIND-update.sh"
  setup_case "$KIND"
  run_case
  [[ "$RC" == 0 && ! -e "$TXN" ]] || fail "$KIND healthy activation failed"
  grep -q '# candidate' "$ACTIVE_BIN" || fail "$KIND candidate not installed"
  run_case
  [[ "$RC" == 0 ]] || fail "$KIND verified activation fast path failed"
  grep -q 'Already on' "$CASE_DIR/run.log" || fail "$KIND fast path missing"

  for failure in RESTART_FAIL=candidate HEALTH_FAIL=candidate; do
    setup_case "$KIND"
    run_case "$failure"
    [[ "$RC" == 1 && ! -e "$TXN" ]] || fail "$KIND failed activation must roll back and clear verified journal: $failure"
    assert_previous
  done

  for crash in CRASH_SWAP=1 CRASH_RESTART=1; do
    setup_case "$KIND"
    run_case "$crash"
    [[ "$RC" == 137 && -d "$TXN" ]] || fail "$KIND crash did not retain journal: $crash"
    grep -q '# candidate' "$ACTIVE_BIN" || fail "$KIND crash must follow binary swap"
    if [[ "$KIND" == tap && "$crash" == CRASH_RESTART=1 ]]; then
      [[ "$(cat "$CASE_DIR/bin/.version")" == 41278964ec8e3253e70d4e919dfb8e34211c543d ]] || fail "TAP publication crash missing desired provenance"
    fi
    fetches="$(wc -l < "$CASE_DIR/fetch.log")"
    assert_recovery
    [[ "$(wc -l < "$CASE_DIR/fetch.log")" == "$fetches" ]] || fail "$KIND recovery must precede network/version fast path"
  done

  for failure in RESTART_FAIL=all HEALTH_FAIL=all; do
    setup_case "$KIND"
    run_case "$failure"
    [[ "$RC" == 1 && -d "$TXN" ]] || fail "$KIND failed rollback must retain journal: $failure"
    assert_previous
    assert_recovery
  done

  setup_case "$KIND"
  run_case CRASH_SWAP=1
  [[ "$RC" == 137 && -d "$TXN" ]] || fail "$KIND rollback-interruption setup"
  rm "$CASE_DIR/crashed"
  run_case CRASH_SWAP=1
  [[ "$RC" == 137 && -d "$TXN" ]] || fail "$KIND interrupted rollback must retain journal"
  assert_recovery

  setup_case "$KIND"
  run_case SYNC_FAIL=1
  [[ "$RC" == 1 && -d "$TXN" ]] || fail "$KIND journal sync failure must fail closed"
  assert_previous
  [[ ! -e "$CASE_DIR/systemctl.log" ]] || fail "$KIND restarted despite journal sync failure"
  assert_recovery

  setup_case "$KIND"
  run_case CRASH_SWAP=1
  printf corrupt >> "$TXN/$KIND"
  restarts=0
  [[ ! -f "$CASE_DIR/systemctl.log" ]] || restarts="$(wc -l < "$CASE_DIR/systemctl.log")"
  run_case
  [[ "$RC" == 1 && -d "$TXN" ]] || fail "$KIND corrupt journal must fail closed"
  [[ ! -f "$CASE_DIR/systemctl.log" || "$(wc -l < "$CASE_DIR/systemctl.log")" == "$restarts" ]] || fail "$KIND corrupt journal restarted service"
  echo "ok: $KIND activation, failures, interrupted swap/publication/rollback, recovery, sync failure, corrupt snapshot"
done

echo 'ALL RUNTIME-UPDATER RECOVERY TESTS PASSED'
