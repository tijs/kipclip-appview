#!/usr/bin/env bash
# Cold-start install of Deno into /opt/deno/bin/deno.
#
# Run once on a fresh box before deploy/release/bootstrap.sh — the
# bootstrap path expects /opt/deno/bin/deno to already exist (kipclip.service
# ExecStart references it).
#
# After this, deno-update.timer keeps the binary current (weekly).
#
# Required: root, curl, unzip.
set -euo pipefail

ARCH="${DENO_INSTALL_ARCH:-aarch64-unknown-linux-gnu}"
DENO_DIR="/opt/deno/bin"
DENO_BIN="${DENO_DIR}/deno"
LATEST_URL="https://dl.deno.land/release-latest.txt"
ZIP_URL_BASE="https://github.com/denoland/deno/releases/download"

if [[ $EUID -ne 0 ]]; then
  echo "ERROR: must run as root (sudo $0)" >&2
  exit 1
fi

log() { echo "==> $*"; }
err() { echo "ERROR: $*" >&2; }

for tool in curl unzip sha256sum install; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    err "required tool not found: $tool (run install-prereqs.sh first)"
    exit 1
  fi
done

if [[ -x "$DENO_BIN" ]]; then
  log "Deno already installed: $("$DENO_BIN" --version | head -1)"
  log "To upgrade, use deno-update.sh (or trigger deno-update.service)."
  exit 0
fi

log "Resolving latest Deno"
VERSION="$(curl -fsSL --max-time 10 "$LATEST_URL" | tr -d '[:space:]')"
[[ -n "$VERSION" ]] || { err "could not fetch latest version"; exit 1; }
log "Installing Deno $VERSION ($ARCH)"

ZIP_URL="${ZIP_URL_BASE}/${VERSION}/deno-${ARCH}.zip"
SHA_URL="${ZIP_URL}.sha256sum"

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

curl -fsSL --max-time 120 -o "$TMP_DIR/deno.zip" "$ZIP_URL"
curl -fsSL --max-time 30 -o "$TMP_DIR/deno.zip.sha256" "$SHA_URL"

log "Verifying sha256"
(cd "$TMP_DIR" && sha256sum -c deno.zip.sha256) >/dev/null

unzip -q -o "$TMP_DIR/deno.zip" -d "$TMP_DIR"
[[ -x "$TMP_DIR/deno" ]] || { err "zip did not contain deno binary"; exit 1; }

mkdir -p "$DENO_DIR"
install -m 0755 "$TMP_DIR/deno" "$DENO_BIN"

log "✅ Installed: $("$DENO_BIN" --version | head -1)"
