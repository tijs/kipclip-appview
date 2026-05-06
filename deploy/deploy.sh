#!/usr/bin/env bash
# Deploy kipclip to the STAGING box from the operator's machine via rsync.
#
# IMPORTANT: production (kipclip.com / kipclip-box) uses the pull-based
# release flow keyed on semver git tags. Push releases by tagging:
#
#     git tag -a vX.Y.Z -m "vX.Y.Z - description"
#     git push origin main --tags
#
# See deploy/release/README.md for the full runbook. The box pulls
# automatically within ~60s; this script must NOT be used to deploy to
# production (it would silently overwrite /etc/caddy/Caddyfile and
# bypass the atomic-swap release machinery).
#
# Usage: ./deploy/deploy.sh [host]
#   host defaults to staging.kipclip.com
set -euo pipefail

HOST="${1:-staging.kipclip.com}"

# Prod-host guard: refuse to deploy to production via rsync. The
# pull-based release flow is the only supported path for kipclip.com.
case "$HOST" in
  kipclip.com|www.kipclip.com|kipclip-box|178.104.156.35)
    echo "ERROR: this script targets staging only." >&2
    echo "Production releases use the pull-based flow — tag a release" >&2
    echo "and push tags. See deploy/release/README.md." >&2
    exit 1
    ;;
esac
APP_DIR="/var/lib/kipclip/app"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

echo "→ Syncing repo to $HOST:$APP_DIR"
rsync -az --delete \
  --exclude .git \
  --exclude node_modules \
  --exclude _fresh \
  --exclude .local \
  --exclude tests \
  "$ROOT/" "$HOST:$APP_DIR/"

echo "→ Building on $HOST"
ssh "$HOST" "cd $APP_DIR && /opt/deno/bin/deno task build"

echo "→ Updating Caddyfile + systemd units"
scp "$ROOT/deploy/Caddyfile" "$HOST:/etc/caddy/Caddyfile"
scp "$ROOT/deploy/systemd/kipclip.service" "$HOST:/etc/systemd/system/kipclip.service"
scp "$ROOT/deploy/systemd/tap.service" "$HOST:/etc/systemd/system/tap.service"

echo "→ Reloading services"
ssh "$HOST" "sudo systemctl daemon-reload && sudo systemctl restart kipclip && sudo systemctl reload caddy"

echo "✓ Deployed"
