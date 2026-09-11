#!/usr/bin/env bash
# Read-only weekly box status report (run on the box, root).
#
# Emits the fields the weekly housekeeping report needs, in machine-greppable
# key=value lines:
#
#   - per-unit: ExecMainStatus (last command exit code) SEPARATE from systemd
#     Result — a drift-alert exit 1/3 must be reported as non-clean even
#     though the unit row says failed; never collapse to "Result=ok".
#   - journal oldest-entry timestamp + retention horizon + disk usage
#     (report the horizon; never hide drift by changing journald limits).
#   - monotonic release-timer freshness: seconds until the next
#     kipclip-release.timer tick per the MONOTONIC clock (wall-clock skew
#     cannot fake this).
#
# Usage: sudo bash deploy/release/box-report.sh   (on the box, from the
# kipclip source checkout; run via ssh by the weekly housekeeping pass).
set -uo pipefail

# drift-alert exit codes (must stay in sync with scripts/drift-alert.ts):
# 0 clean, 1 drift, 2 audit failed, 3 PDS errors present (not repaired).
describe_drift_exit() {
  case "$1" in
    0) echo "clean" ;;
    1) echo "DRIFT-DETECTED" ;;
    2) echo "AUDIT-FAILED" ;;
    3) echo "PDS-ERRORS" ;;
    *) echo "unknown" ;;
  esac
}

now_monotonic_usec() {
  awk '{printf "%d\n", $1 * 1000000}' /proc/uptime
}

# Pure-uint check so systemd's nonnumeric values (empty, "infinity") never
# reach arithmetic — `$(( infinity - now ))` is a hard "operand expected"
# error that would abort the surrounding line of the report.
is_uint() { [[ "$1" =~ ^[0-9]+$ ]]; }

# Seconds until the next monotonic tick, or "-" when systemd reports a
# nonnumeric/zero/absent value (e.g. "infinity" for a timer without a
# monotonic next-elapse). Fail-safe by construction: it never emits an
# arithmetic error, and callers always get something greppable.
fresh_seconds() {
  local next_mono="$1" now="$2"
  if is_uint "$next_mono" && is_uint "$now" && [[ "$next_mono" != "0" ]]; then
    echo "$(( (next_mono - now) / 1000000 ))"
  else
    echo "-"
  fi
}

echo "== units =="
for u in kipclip.service tap.service kipclip-release.service kipclip-drift-alert.service kipclip-reconcile.service tap-update.service deno-update.service; do
  ActiveState="$(systemctl show "$u" -p ActiveState --value 2>/dev/null)"
  Result="$(systemctl show "$u" -p Result --value 2>/dev/null)"
  ExecMainStatus="$(systemctl show "$u" -p ExecMainStatus --value 2>/dev/null)"
  LastRun="$(systemctl show "$u" -p ExecMainStartTimestamp --value 2>/dev/null)"
  extra=""
  if [[ "$u" == "kipclip-drift-alert.service" && -n "$ExecMainStatus" ]]; then
    extra=" drift_kind=$(describe_drift_exit "$ExecMainStatus")"
  fi
  echo "unit=$u active=$ActiveState result=$Result exec_main_status=$ExecMainStatus last_run=${LastRun:-never}$extra"
done

echo "== timers (monotonic freshness) =="
_now="$(now_monotonic_usec)"
for t in kipclip-release.timer tap-update.timer deno-update.timer kipclip-drift-alert.timer kipclip-reconcile.timer restic-backup.timer; do
  Active="$(systemctl is-active "$t" 2>/dev/null)"
  NextMono="$(systemctl show "$t" -p NextElapseUSecMonotonic --value 2>/dev/null)"
  NextWall="$(systemctl show "$t" -p NextElapseUSecRealtime --value 2>/dev/null)"
  LastTrig="$(systemctl show "$t" -p LastTriggerUSec --value 2>/dev/null)"
  if [[ -n "$NextMono" && "$NextMono" != "0" && -n "$_now" ]]; then
    Fresh="$(fresh_seconds "$NextMono" "$_now")"
  else
    Fresh="-"
  fi
  echo "timer=$t active=$Active next_monotonic_in_s=$Fresh next_wall=${NextWall:-$NextMono} last_trigger=${LastTrig:-never}"
done

echo "== journal =="
oldest="$(journalctl --no-pager -o short-precise --reverse -n 1 2>/dev/null | head -1)"
newest="$(journalctl --no-pager -o short-precise -n 1 2>/dev/null | head -1)"
usage="$(journalctl --disk-usage --no-pager 2>/dev/null | head -1)"
echo "journal_oldest=${oldest:0:33}"
echo "journal_newest=${newest:0:33}"
echo "journal_disk_usage=${usage}"
# Retention config (report-only; changing these to hide drift is forbidden).
echo "journal_systemd_config=$(systemctl cat systemd-journald 2>/dev/null | grep -E 'SystemMaxUse|MaxRetentionSec|MaxFileSec' | tr '\n' ';')"

echo "== release provenance =="
if [[ -f /var/lib/kipclip/current/.version ]]; then
  echo "app_release=$(cat /var/lib/kipclip/current/.version)"
fi
echo "tap_source_sha=$(cat /opt/tap/.version 2>/dev/null || echo missing)"
echo "tap_binary_sha=$(cat /opt/tap/.binary.sha256 2>/dev/null || echo missing)"
echo "tap_patches_sha=$(cat /opt/tap/.patches.sha256 2>/dev/null | cut -c1-16 || echo missing)"
echo "tap_bin_sha_now=$(sha256sum /opt/tap/tap 2>/dev/null | awk '{print $1}')"
echo "release_pin=$(cat /etc/kipclip/release-pin 2>/dev/null || echo none)"
echo "tap_pin=$(cat /etc/tap/tap-version 2>/dev/null || echo none)"
