#!/usr/bin/env bash
# Deploy kipclip to the staging box from the operator's machine.
# Usage: ./deploy/deploy.sh [host]
#   host defaults to staging.kipclip.com
set -euo pipefail

HOST="${1:-staging.kipclip.com}"
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
