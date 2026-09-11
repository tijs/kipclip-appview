#!/usr/bin/env bash
# Regression: the SUPPORTED production deployment path must install the
# changed systemd units and apply the updated TAP DB permission model.
#
# bootstrap.sh is the only path that writes /etc/systemd/system on the box —
# a source-only change to a unit it never installs would leave production
# semantics stale. These assertions pin the wiring:
#   - kipclip-drift-alert.service + timer are installed and enabled;
#   - tap.service (UMask=0007 so a fresh tap.db is group-writable) is
#     installed by the same path;
#   - bootstrap idempotently enforces tap:tap 2770 dir / 0660 db (the same
#     layout tap-update.sh re-asserts weekly).
#
# Run: bash tests/shell/bootstrap.test.sh   (any bash >= 3.2)
set -u
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
BOOTSTRAP="$ROOT/deploy/release/bootstrap.sh"
TAP_SERVICE="$ROOT/deploy/systemd/tap.service"
DRIFT_SERVICE="$ROOT/deploy/systemd/kipclip-drift-alert.service"

fail() { echo "FAIL: $*" >&2; exit 1; }
ok() { echo "ok: $*"; }

[ -f "$BOOTSTRAP" ] || fail "bootstrap.sh not found: $BOOTSTRAP"
bash -n "$BOOTSTRAP" || fail "bash -n syntax check on bootstrap.sh"

# The drift-alert unit + timer must be installed/refreshed by bootstrap
# (unconditional: it is a kipclip app unit, not TAP-dependent).
grep -q 'deploy/systemd/kipclip-drift-alert\.service' "$BOOTSTRAP" ||
  fail "bootstrap must install kipclip-drift-alert.service (source-only changes would never reach the box)"
grep -q 'deploy/systemd/kipclip-drift-alert\.timer' "$BOOTSTRAP" ||
  fail "bootstrap must install kipclip-drift-alert.timer"
grep -q 'enable --now kipclip-drift-alert\.timer' "$BOOTSTRAP" ||
  fail "bootstrap must enable kipclip-drift-alert.timer"

# tap.service ships UMask=0007 so a freshly created tap.db is group-writable
# (0660) without waiting for a weekly tap-update chmod.
grep -q 'UMask=0007' "$TAP_SERVICE" ||
  fail "tap.service must carry UMask=0007 (fresh tap.db stays group-writable)"
grep -q 'deploy/systemd/tap\.service' "$BOOTSTRAP" ||
  fail "bootstrap must install tap.service (UMask lands on the box via the supported path)"

# TAP DB group-write layout enforced idempotently by the tap-update/bootstrap
# flow: 2770 setgid dir + 0660 db, never world-writable.
grep -q 'chmod 2770' "$BOOTSTRAP" || fail "bootstrap must enforce dir 2770 (setgid group-rwx)"
grep -q 'chmod 0660' "$BOOTSTRAP" || fail "bootstrap must enforce db 0660 (group-rw)"
grep -qE 'chmod (0666|0777|1777|0644)' "$BOOTSTRAP" && fail "bootstrap must never set a world-visible TAP mode"

# drift-alert unit wiring: kipclip user, supplementary group tap, write path.
grep -q 'SupplementaryGroups=tap' "$DRIFT_SERVICE" ||
  fail "kipclip-drift-alert.service must add SupplementaryGroups=tap"
grep -q 'ReadWritePaths=.*/var/lib/tap' "$DRIFT_SERVICE" ||
  fail "kipclip-drift-alert.service must allow writing /var/lib/tap"
grep -q '/var/lib/tap' "$DRIFT_SERVICE" || fail "drift-alert unit must reference the tap db path"

echo
echo "ALL BOOTSTRAP WIRING TESTS PASSED"