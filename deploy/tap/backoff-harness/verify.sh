#!/usr/bin/env bash
# Verify the TAP backoff fixture: vet + run the retry-arithmetic tests.
# Run from anywhere; requires a Go toolchain (on the box:
# /usr/local/go/bin/go or the distro go).
#
# The REAL gate for deployments is tap-update.sh, which refuses to build
# unless the pinned base + patch apply cleanly; this harness regression-tests
# the patched arithmetic itself.
set -euo pipefail
cd "$(dirname "$0")"
go vet ./...
echo "==> running backoff tests"
go test ./... -count=1
echo "==> OK: TAP backoff arithmetic verified (zero/normal/capped/very-large)"
