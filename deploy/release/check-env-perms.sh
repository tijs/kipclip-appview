#!/usr/bin/env bash
# Audit ownership + mode of secret-bearing env files on the box.
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
# 0640 root:root would silently break kipclip.service (kipclip user
# can't read root-only files in the root group) — explicitly rejected.
set -euo pipefail

log()   { echo "==> $*"; }
ok()    { echo "    OK   $*"; }
fail()  { echo "    FAIL $*" >&2; }
warn()  { echo "    WARN $*" >&2; }

require_tool() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "ERROR: required tool not found: $1" >&2
    exit 1
  fi
}
require_tool stat

# (file, expected_mode, expected_owner, expected_group, optional)
# `optional` = "1" → missing file is OK (warn, no fail). "0" → missing → fail.
declare -a SPECS=(
  "/etc/kipclip/env|640|root|kipclip|0"
  "/etc/kipclip/restic.env|600|root|root|0"
  "/etc/tap/env|640|root|tap|1"
  "/etc/kipclip/release-pin|644|root|kipclip|1"
)

errors=0
log "Auditing env file permissions"
for spec in "${SPECS[@]}"; do
  IFS='|' read -r path want_mode want_owner want_group optional <<< "$spec"
  if [[ ! -e "$path" ]]; then
    if [[ "$optional" == "1" ]]; then
      warn "$path missing (optional)"
    else
      fail "$path missing — required"
      errors=$((errors + 1))
    fi
    continue
  fi
  # %a = octal mode without leading 0; %U = owner; %G = group.
  read -r got_mode got_owner got_group < <(stat -c '%a %U %G' "$path")
  if [[ "$got_mode" != "$want_mode" ]] \
    || [[ "$got_owner" != "$want_owner" ]] \
    || [[ "$got_group" != "$want_group" ]]; then
    fail "$path has $got_mode $got_owner:$got_group (want $want_mode $want_owner:$want_group)"
    errors=$((errors + 1))
  else
    ok "$path ($got_mode $got_owner:$got_group)"
  fi
done

if (( errors > 0 )); then
  fail "$errors file(s) with unsafe perms or wrong ownership"
  fail "fix with: chown <owner>:<group> <path> && chmod <mode> <path>"
  exit 1
fi

log "✅ All env files OK"
