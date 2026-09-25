#!/usr/bin/env bash
# Regression: restic-backup.service must run as root so it can read the
# root:root 0600 /etc/kipclip/restic.env secret file it sources.
#
# Production incident (nightly Sep 19-25): the unit ran as
# User=kipclip/Group=kipclip while check-env-perms.sh enforces
# /etc/kipclip/restic.env as root:root 0600, so every nightly
# `source /etc/kipclip/restic.env` in restic-backup.sh failed with
# "Permission denied". Pins (release blockers):
#   - the unit never runs as a non-root user (User=/Group= must be root
#     or absent — systemd defaults to root);
#   - hardening + ReadWritePaths are preserved (writes still scoped to
#     /var/lib/kipclip, /var/lib/tap, /tmp);
#   - bootstrap installs this exact unit (a source-only unit change would
#     never reach the box);
#   - every doc/example that tells an operator how to create or audit
#     /etc/kipclip/restic.env says root:root 0600 — never root:kipclip 0640.
#
# Run: bash tests/shell/restic-backup.test.sh   (any bash >= 3.2)
set -u
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SERVICE="$ROOT/deploy/systemd/restic-backup.service"
BOOTSTRAP="$ROOT/deploy/release/bootstrap.sh"
CHECK_ENV_PERMS="$ROOT/deploy/release/check-env-perms.sh"
README="$ROOT/deploy/README.md"
RELEASE_README="$ROOT/deploy/release/README.md"
ENV_EXAMPLE="$ROOT/deploy/restic.env.example"

fail() { echo "FAIL: $*" >&2; exit 1; }
ok() { echo "ok: $*"; }

[ -f "$SERVICE" ] || fail "unit not found: $SERVICE"
[ -f "$BOOTSTRAP" ] || fail "bootstrap not found: $BOOTSTRAP"

# 1. The unit runs as root. Explicit User=/Group= must be root — a kipclip
#    user cannot read the root:root 0600 env file. Absent = systemd default
#    (root), also fine.
grep -qE '^User=kipclip$|^Group=kipclip$' "$SERVICE" &&
  fail "restic-backup.service must NOT run as kipclip (cannot read root:root 0600 restic.env)"
if grep -qE '^User=' "$SERVICE"; then
  grep -q '^User=root$' "$SERVICE" ||
    fail "restic-backup.service User= must be root (got a non-root User=)"
fi
if grep -qE '^Group=' "$SERVICE"; then
  grep -q '^Group=root$' "$SERVICE" ||
    fail "restic-backup.service Group= must be root (got a non-root Group=)"
fi
grep -q 'EnvironmentFile=/etc/kipclip/restic\.env' "$SERVICE" ||
  fail "restic-backup.service must still load EnvironmentFile=/etc/kipclip/restic.env"
ok "restic-backup.service runs as root (User/Group=root or absent) and loads the env file"

# 2. Hardening + read/write paths preserved — the root fix must not have
#    broadened filesystem access.
for k in 'NoNewPrivileges=true' 'ProtectSystem=strict' 'ProtectHome=true' 'PrivateTmp=true'; do
  grep -qF "$k" "$SERVICE" || fail "restic-backup.service hardening missing: $k"
done
grep -q 'ReadWritePaths=.*/var/lib/kipclip' "$SERVICE" ||
  fail "restic-backup.service must keep /var/lib/kipclip in ReadWritePaths"
grep -q 'ReadWritePaths=.*/var/lib/tap' "$SERVICE" ||
  fail "restic-backup.service must keep /var/lib/tap in ReadWritePaths"
ok "hardening + ReadWritePaths preserved"

# 3. Bootstrap installs the fixed unit — the supported production path.
grep -q 'deploy/systemd/restic-backup\.service' "$BOOTSTRAP" ||
  fail "bootstrap must install restic-backup.service (source-only unit changes never reach the box)"
ok "bootstrap installs restic-backup.service"

# 4. The secret-file contract is root:root 0600 everywhere an operator
#    creates or audits it. The app env (root:kipclip 0640) is separate.
grep -q '/etc/kipclip/restic\.env|600|root|root|0' "$CHECK_ENV_PERMS" ||
  fail "check-env-perms.sh must require restic.env root:root 0600"
grep -q 'chown root:root /etc/kipclip/restic\.env' "$README" ||
  fail "deploy/README.md bootstrap must chown restic.env root:root (not root:kipclip)"
grep -q 'chmod 0600 /etc/kipclip/restic\.env' "$README" ||
  fail "deploy/README.md bootstrap must chmod restic.env 0600"
grep -q 'chown root:kipclip[^&]*/etc/kipclip/restic\.env' "$README" &&
  fail "deploy/README.md must not chown restic.env root:kipclip"
grep -q '/etc/kipclip/restic\.env.*root:root.*0600' "$README" ||
  fail "deploy/README.md ownership table must list restic.env root:root 0600"
grep -q '/etc/kipclip/restic\.env.*0600' "$RELEASE_README" ||
  fail "deploy/release/README.md must list restic.env 0600"
grep -q 'root:root' "$ENV_EXAMPLE" ||
  fail "restic.env.example must document root:root ownership"
grep -q '0600' "$ENV_EXAMPLE" ||
  fail "restic.env.example must document mode 0600"
grep -qE '0640|root:kipclip' "$ENV_EXAMPLE" &&
  fail "restic.env.example must not document 0640/root:kipclip (that is the app-env contract, not restic.env)"
ok "env-file contract consistent everywhere: /etc/kipclip/restic.env = root:root 0600"

echo
echo "ALL RESTIC-BACKUP WIRING TESTS PASSED"