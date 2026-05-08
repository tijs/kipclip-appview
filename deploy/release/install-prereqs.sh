#!/usr/bin/env bash
# Install OS-level prerequisites for a fresh kipclip box.
#
# Run once on a clean Debian 13 host BEFORE deploy/release/bootstrap.sh.
# Idempotent — apt-get install is a no-op if already at the right version.
#
# Required: root.
set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "ERROR: must run as root (sudo $0)" >&2
  exit 1
fi

log() { echo "==> $*"; }

# Caddy isn't in the default Debian repos — it has its own apt source.
# This block is idempotent; re-running on a configured box is a no-op.
if [[ ! -f /etc/apt/sources.list.d/caddy-stable.list ]]; then
  log "Adding Caddy apt repo"
  apt-get update
  apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl
  curl -fsSL "https://dl.cloudsmith.io/public/caddy/stable/gpg.key" \
    | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -fsSL "https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt" \
    > /etc/apt/sources.list.d/caddy-stable.list
fi

log "apt update"
apt-get update

log "Installing prereqs"
# Pkg roles:
#   caddy           — TLS edge proxy
#   restic          — encrypted backups to B2
#   git             — pull-based release flow + indigo source clone
#   jq              — used by deploy scripts + ad-hoc operator queries
#   sqlite3         — inspect mirror.db / tap.db on the box
#   fail2ban        — sshd brute-force protection
#   unattended-upgrades — security-only auto-updates (Debian)
#   curl, unzip     — deno-update.sh download path
#   ca-certificates — TLS roots for HTTPS fetches
#   golang-go       — TAP build (cmd/tap from indigo)
#   build-essential — gcc, used by deno cgo bindings during build
apt-get install -y \
  caddy \
  restic \
  git \
  jq \
  sqlite3 \
  fail2ban \
  unattended-upgrades \
  curl \
  unzip \
  ca-certificates \
  golang-go \
  build-essential

log "Enabling unattended-upgrades + fail2ban"
systemctl enable --now unattended-upgrades.service
systemctl enable --now fail2ban.service

log "✅ Prereqs installed. Next: create users (kipclip, tap), then run deploy/release/bootstrap.sh"
