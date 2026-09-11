#!/usr/bin/env bash
# Regression for deploy/release/check-env-perms.sh TAP DB access audit.
#
# drift-alert runs as the kipclip user with SupplementaryGroups=tap and
# deletes quarantined TAP repo rows in /var/lib/tap/tap.db. The data dir must
# be tap:tap 2770 (setgid -> a recreated tap.db keeps group tap) and the db
# tap:tap 0660 — group-writable, NEVER world-writable. The audit must:
#   - pass a correct layout (errors=0),
#   - flag a world-visible or non-group-writable layout (errors>=1),
#   - stay quiet when tap.db has not been created yet (optional, WARN only).
#
# Run: bash tests/shell/check-env-perms.test.sh   (any bash >= 3.2)
set -u
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SCRIPT="$ROOT/deploy/release/check-env-perms.sh"

fail() { echo "FAIL: $*" >&2; exit 1; }
ok() { echo "ok: $*"; }

[ -f "$SCRIPT" ] || fail "script not found: $SCRIPT"
bash -n "$SCRIPT" || fail "bash -n syntax check"

# Extract everything above the `BASH_SOURCE[0] == $0` main guard so tests
# can source the functions + spec table without executing main().
defs="$(mktemp)"
sed '/^if \[\[ "${BASH_SOURCE\[0\]}" == "$0" \]\]/,$d' "$SCRIPT" > "$defs"
trap 'rm -f "$defs"' EXIT

TMP="$(mktemp -d)"
mkdir -p "$TMP/stubs" "$TMP/tap"
touch "$TMP/tap/tap.db"   # exists unless a case points elsewhere
trap 'rm -rf "$TMP"; rm -f "$defs"' EXIT

cat > "$TMP/stubs/stat" <<'STUB'
#!/usr/bin/env bash
# Mimic real `stat -c '%a %U %G'` output: octal mode WITHOUT the leading
# zero (0660 is reported as "660"). The audit must normalize so stat-style
# "660 tap tap" matches the documented tap:tap 0660 contract.
path="${@: -1}"
if [[ "$path" == "$STAT_DIR" ]]; then
  echo "$STAT_DIR_VAL"
elif [[ "$path" == "$STAT_DB" ]]; then
  echo "$STAT_DB_VAL"
else
  echo "644 root root"
fi
exit 0
STUB
chmod +x "$TMP/stubs/stat"

# Run the TAP-DB audit in a sandbox with overridden paths + a stat stub.
# $1 = dir path, $2 = db path, $3 = reported dir stat, $4 = reported db stat.
run_audit() {
  STAT_DIR="$1" STAT_DB="$2" STAT_DIR_VAL="$3" STAT_DB_VAL="$4" \
  KIPCLIP_TAP_DIR="$1" KIPCLIP_TAP_DB="$2" \
  PATH="$TMP/stubs:$PATH" \
  bash -c '
    set -u
    source "$1"
    set +e
    errors=0
    audit_tap_db_access
    echo "errors=$errors"
  ' _ "$defs" 2>&1
}

t1() {
  # Regression for the production bug: stat reports 0660 as "660" (no
  # leading zero). A correct tap:tap 0660 layout must still pass.
  local out
  out="$(run_audit "$TMP/tap" "$TMP/tap/tap.db" "2770 tap tap" "660 tap tap")"
  echo "$out" | grep -q "^errors=0$" || fail "correct layout must pass (stat-style 660 == 0660); got: $out"
  echo "$out" | grep -q "OK .*$TMP/tap/tap.db" || fail "db verification line missing; got: $out"
  ok "TAP DB audit: tap:tap 2770 dir + 0660 db passes with real stat-style output (660)"
}
t1

t2() {
  # World-writable db — stat would report mode 0666 as "666". Must be
  # rejected after normalization, never accepted as 0660.
  local out
  out="$(run_audit "$TMP/tap" "$TMP/tap/tap.db" "2770 tap tap" "666 tap tap")"
  echo "$out" | grep -q "^errors=1$" || fail "world-writable db must be flagged; got: $out"
  echo "$out" | grep -q "FAIL" || fail "world-writable db must emit a FAIL line; got: $out"
  ok "TAP DB audit: world-visible db (stat-style 666 / 0666) flagged"
}
t2

t3() {
  local out
  out="$(run_audit "$TMP/tap" "$TMP/tap/not-created.db" "2770 tap tap" "0660 tap tap")"
  echo "$out" | grep -q "^errors=0$" || fail "missing optional db must stay quiet; got: $out"
  echo "$out" | grep -q "WARN" || fail "missing optional db should warn; got: $out"
  ok "TAP DB audit: not-yet-created db is a WARN, not a failure"
}
t3

t4() {
  local out
  out="$(run_audit "$TMP/tap" "$TMP/tap/tap.db" "2770 root root" "0660 tap tap")"
  echo "$out" | grep -q "^errors=1$" || fail "wrong dir group must be flagged; got: $out"
  ok "TAP DB audit: wrong ownership flagged"
}
t4

echo
echo "ALL CHECK-ENV-PERMS SHELL TESTS PASSED"