#!/usr/bin/env bash
# Audit ownership + mode of secret-bearing env files on the box, plus the
# TAP DB access layout that drift-alert needs.
#
# Run automatically by bootstrap.sh at the end of bootstrap, and on
# demand by an operator (e.g., after editing one of the env files):
#
#   sudo /var/lib/kipclip/source/deploy/release/check-env-perms.sh
#
# Exit codes:
#   0 — all files OK or missing-but-optional
#   1 — one or more files have unsafe perms or wrong ownership
#
# Acceptable per file:
#   /etc/kipclip/env        — root:kipclip 0640  (kipclip.service reads it)
#   /etc/kipclip/restic.env — root:root    0600  (restic-backup.service runs as root)
#   /etc/tap/env            — root:tap     0640  (tap.service reads it; optional)
#   /etc/kipclip/release-pin— root:kipclip 0644  (operator-pin file; not secret)
#
# TAP DB access (drift-alert quarantine): the daily drift alert runs as the
# kipclip user with SupplementaryGroups=tap and deletes quarantined TAP repo
# rows in /var/lib/tap/tap.db. The layout must be:
#   /var/lib/tap        tap:tap 2770  (setgid; group rwx, NO world)
#   /var/lib/tap/tap.db tap:tap 0660  (group rw, NO world)
# Paths are KIPCLIP_TAP_DIR/KIPCLIP_TAP_DB-overridable so the audit can be
# dry-run-verified against a sandbox.
#
# 0640 root:root would silently break kipclip.service (kipclip user
# can't read root-only files in the root group) — explicitly rejected.
set -euo pipefail

require_tool() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "ERROR: required tool not found: $1" >&2
    exit 1
  fi
}
require_tool stat

TAP_DIR="${KIPCLIP_TAP_DIR:-/var/lib/tap}"
TAP_DB="${KIPCLIP_TAP_DB:-${TAP_DIR}/tap.db}"

log()   { echo "==> $*"; }
ok()    { echo "    OK   $*"; }
fail()  { echo "    FAIL $*" >&2; }
warn()  { echo "    WARN $*" >&2; }

errors=0

# (file, expected_mode, expected_owner, expected_group, optional)
# `optional` = "1" → missing file is OK (warn, no fail). "0" → missing → fail.
declare -a SPECS=(
  "/etc/kipclip/env|640|root|kipclip|0"
  "/etc/kipclip/restic.env|600|root|root|0"
  "/etc/tap/env|640|root|tap|1"
  "/etc/kipclip/release-pin|644|root|kipclip|1"
)

# TAP DB access spec (same shape as SPECS). Optional: a fresh box has no
# tap.db until the first tap.service run, so a missing db only warns; the
# dir + db are expected once TAP exists.
declare -a TAP_ACCESS_SPECS=(
  "${TAP_DIR}|2770|tap|tap|1"
  "${TAP_DB}|0660|tap|tap|1"
)

# One spec: stat the path, compare mode + owner + group, count failures.
check_perms() {
  local path="$1" want_mode="$2" want_owner="$3" want_group="$4" optional="$5"
  local got_mode got_owner got_group
  if [[ ! -e "$path" ]]; then
    if [[ "$optional" == "1" ]]; then
      warn "$path missing (optional)"
    else
      fail "$path missing — required"
      errors=$((errors + 1))
    fi
    return
  fi
  # %a = octal mode without leading 0 (e.g. "660" for 0660); %U = owner;
  # %G = group.
  if ! read -r got_mode got_owner got_group < <(stat -c '%a %U %G' "$path" 2>/dev/null); then
    fail "$path stat failed"
    errors=$((errors + 1))
    return
  fi
  # Normalize modes as octal numbers: stat omits the leading 0 that the
  # spec tables keep ("660" vs "0660" must compare equal), while a real
  # mode difference is still an error. Never loosens the contract — an
  # unsafe mode (e.g. world-writable 666) normalizes to a different value
  # and still fails.
  if (( 8#$got_mode != 8#$want_mode )) \
    || [[ "$got_owner" != "$want_owner" ]] \
    || [[ "$got_group" != "$want_group" ]]; then
    fail "$path has $got_mode $got_owner:$got_group (want $want_mode $want_owner:$want_group)"
    errors=$((errors + 1))
  else
    ok "$path ($got_mode $got_owner:$got_group)"
  fi
}

# TAP DB access — drift-alert (kipclip + group tap) deletes quarantined
# TAP repo rows in tap.db, so the db and its dir must be group-writable and
# never world-visible. Export as its own function so a sandbox test can run
# exactly this audit.
audit_tap_db_access() {
  local spec path want_mode want_owner want_group optional
  for spec in "${TAP_ACCESS_SPECS[@]}"; do
    IFS='|' read -r path want_mode want_owner want_group optional <<< "$spec"
    check_perms "$path" "$want_mode" "$want_owner" "$want_group" "$optional"
  done
}

main() {
  local spec path want_mode want_owner want_group optional
  log "Auditing env file permissions"
  for spec in "${SPECS[@]}"; do
    IFS='|' read -r path want_mode want_owner want_group optional <<< "$spec"
    check_perms "$path" "$want_mode" "$want_owner" "$want_group" "$optional"
  done

  log "Auditing TAP DB access (drift-alert group-write)"
  audit_tap_db_access

  if (( errors > 0 )); then
    fail "$errors file(s) with unsafe perms or wrong ownership"
    fail "fix with: chown <owner>:<group> <path> && chmod <mode> <path>"
    exit 1
  fi

  log "✅ All env files + TAP DB access OK"
}

# Only run when executed directly (not when sourced by a test harness).
if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi