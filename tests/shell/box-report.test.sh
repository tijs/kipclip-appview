#!/usr/bin/env bash
# Regression tests for deploy/release/box-report.sh.
#
# Pins (release blockers):
#   - Monotonic timer freshness NEVER feeds nonnumeric systemd values
#     ("infinity", empty, garbage) into arithmetic. The report must produce
#     `next_monotonic_in_s=-` and NO bash "operand expected" errors.
#   - describe_drift_exit maps systemd ExecMainStatus to the drift classes.
#
# Run: bash tests/shell/box-report.test.sh   (any bash >= 3.2)
set -u
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SCRIPT="$ROOT/deploy/release/box-report.sh"

fail() { echo "FAIL: $*" >&2; exit 1; }
ok() { echo "ok: $*"; }

[ -f "$SCRIPT" ] || fail "script not found: $SCRIPT"
bash -n "$SCRIPT" || fail "bash -n syntax check"

# ---- function-level: extract the helper defs (between `set -uo pipefail`
# ---- and the first top-level report line) and source them.
extract() {
  awk '
    /^set -uo pipefail$/ { on = 1; next }
    /^echo "== units =="/ { exit }
    on { print }
  ' "$SCRIPT"
}

defs="$(mktemp)"
extract > "$defs"
trap 'rm -f "$defs"' EXIT

f1() {
  local out
  out="$(bash -c '
    set -u
    source "$1"
    echo "next_monotonic_in_s=$(fresh_seconds "$2" "$3")"
  ' _ "$defs" 'infinity' '1234567890000')"
  [[ "$out" == "next_monotonic_in_s=-" ]] || fail "infinity must yield '-', got: $out"
  ok "fresh_seconds: systemd 'infinity' -> '-' (no arithmetic error)"
}
f1

f2() {
  local out
  out="$(bash -c '
    set -u
    source "$1"
    echo "next_monotonic_in_s=$(fresh_seconds "$2" "$3")"
  ' _ "$defs" '2234567890123' '1234567890000')"
  [[ "$out" == "next_monotonic_in_s=1000000" ]] || fail "numeric delta wrong: $out"
  ok "fresh_seconds: numeric delta computed correctly"
}
f2

f3() {
  local out
  for v in "0" "" "abc" "1.5e9" "-3" "   " NaN; do
    out="$(bash -c '
      set -u
      source "$1"
      echo "next_monotonic_in_s=$(fresh_seconds "$2" "$3")"
    ' _ "$defs" "$v" '1234567890000')"
    [[ "$out" == "next_monotonic_in_s=-" ]] || fail "value '$v' must yield '-', got: $out"
  done
  ok "fresh_seconds: zero/empty/non-numeric values all fail-safe to '-'"
}
f3

f4() {
  local out
  out="$(bash -c '
    set -u
    source "$1"
    for code in 0 1 2 3 42; do echo "$code=$(describe_drift_exit "$code")"; done
  ' _ "$defs")"
  [[ "$out" == $'0=clean\n1=DRIFT-DETECTED\n2=AUDIT-FAILED\n3=PDS-ERRORS\n42=unknown' ]] ||
    fail "describe_drift_exit mapping wrong: $out"
  ok "describe_drift_exit: ExecMainStatus classes mapped (clean/drift/audit/pds-errors/unknown)"
}
f4

# ---- end-to-end: full report with stubbed systemctl/journalctl/awk.
# ---- The old code emitted a bash arithmetic error when NextElapseUSec-
# ---- Monotonic was "infinity"; the new code must print '-' cleanly.
f5() {
  local TMP log err out
  TMP="$(mktemp -d)"
  mkdir -p "$TMP/stubs"
  cat > "$TMP/stubs/systemctl" <<'STUB'
#!/usr/bin/env bash
case "$1" in
  show)
    shift
    unit="$1"; shift
    prop=""
    while [[ $# -gt 0 ]]; do
      if [[ "$1" == "-p" ]]; then prop="$2"; shift 2; else shift; fi
    done
    case "$prop" in
      ActiveState) echo "active";;
      Result) echo "success";;
      ExecMainStatus) echo "0";;
      ExecMainStartTimestamp) echo "2026-09-01 04:00:00 UTC";;
      NextElapseUSecMonotonic) echo "$MONO_VALUE";;
      NextElapseUSecRealtime) echo "2026-09-08 04:00:00 UTC";;
      LastTriggerUSec) echo "2026-09-01 04:00:00 UTC";;
      *) echo "";;
    esac
    ;;
  is-active) echo "active";;
  cat) echo "SystemMaxUse=1G;MaxRetentionSec=1month;MaxFileSec=1week";;
esac
exit 0
STUB
  cat > "$TMP/stubs/journalctl" <<'STUB'
#!/usr/bin/env bash
case "$*" in
  *--disk-usage*) echo "Journals take up 1.2G on disk.";;
  *) echo "Sep 01 04:00:00 host systemd[1]: Started.";;
esac
exit 0
STUB
  cat > "$TMP/stubs/awk" <<'STUB'
#!/usr/bin/env bash
# Box-report only uses awk for /proc/uptime; supply the computed monotonic
# microseconds directly (there is no /proc on macOS).
case "$*" in
  *"/proc/uptime"*) echo "12345670000"; exit 0;;
esac
exec /usr/bin/awk "$@"
STUB
  cat > "$TMP/stubs/sha256sum" <<'STUB'
#!/usr/bin/env bash
for f in "$@"; do
  echo "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef  $f"
done
STUB
  for s in "$TMP"/stubs/*; do chmod +x "$s"; done

  log="$TMP/report.log"
  err="$TMP/report.err"
  MONO_VALUE=infinity PATH="$TMP/stubs:$PATH" bash "$SCRIPT" > "$log" 2> "$err"
  grep -q "next_monotonic_in_s=-" "$log" || fail "infinity run must report '-', got: $(grep next_monotonic "$log")"
  grep -qi "operand expected\|syntax error" "$err" &&
    fail "infinity run still emitted an arithmetic error: $(cat "$err")"

  # A numeric monotonic value flows through the arithmetic (this is what
  # broke with nonnumeric input): a non-negative integer freshness, never '-'.
  MONO_VALUE=2234567890123 PATH="$TMP/stubs:$PATH" bash "$SCRIPT" > "$log" 2> "$err"
  grep -Eq "next_monotonic_in_s=[0-9]+" "$log" ||
    fail "numeric run wrong: $(grep next_monotonic "$log")"
  grep -q "next_monotonic_in_s=-" "$log" && fail "numeric run regressed to '-'"
  rm -rf "$TMP"
  ok "box-report end-to-end: 'infinity' -> '-', numeric values compute, no arithmetic errors"
}
f5

echo
echo "ALL BOX-REPORT SHELL TESTS PASSED"