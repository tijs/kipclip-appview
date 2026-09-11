# TAP source pin, downstream patch, rollback, and post-deploy verification

TAP (`bluesky-social/indigo` `cmd/tap`) is the firehose subscriber feeding
`/api/sync/hook`. It has no release cadence; previously `tap-update.sh` rebuilt
whatever `origin/main` pointed at, which is how the retry-storm build silently
changed under us.

## The bug and the fix

Upstream `cmd/tap/util.go` computes the resync backoff as:

```go
dur := 1 << retries   // computed BEFORE the cap
if dur > max { dur = max }
```

`1 << retries` overflows for large retry counts (on 64-bit ints, shifts ≥ 63
produce 0 or negative values). Observed production effect: retry counts of
15k–162k with retry timestamps only seconds in the future — the backoff
collapsed into a busy loop on five broken repos (3× `RepoNotFound`, 1× TAP-only
`RepoNotFound`, 2× unavailable PDS).

**Upstream status (checked 2026-09-11):** current `main`
(`41278964ec8e3253e70d4e919dfb8e34211c543d`, 2026-09-03) still contains the
overflow; the last commit touching `cmd/tap/util.go` is `1d6a130c35cd`
(2026-02-03). No upstream fix exists to pin. **Decision: downstream patch**,
owned by THIS repository — not an upstream commit, never pushed to
`bluesky-social/indigo`.

| Artifact                                               | Purpose                                                                                                                                                                                                                                                            |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `deploy/tap/patches/0001-tap-backoff-saturating.patch` | Unified diff fixing `backoff()` (cap exponent before shift; base delay stays in `[1, max]` s + ≤1 s jitter). Base: `41278964ec8e3253e70d4e919dfb8e34211c543d`.                                                                                                     |
| `deploy/tap/backoff-harness/`                          | Standalone Go fixture mirroring the patched function byte-for-byte; tests zero / normal / capped / very-large counts and the 1–60 s envelope. `./verify.sh` runs `go vet` + `go test`. Go is not installed on the dev Mac — run it on the box or any Go machine.   |
| `deploy/release/tap-update.sh`                         | Build flow: fetch → checkout immutable base sha → `git apply --check` + apply patches (fail loud on drift) → build → record `.version` (source sha) + `.patches.sha256` + `.binary.sha256` → restart → health check → rollback restoring binary AND recorded SHAs. |

## Pin the production TAP build

Default is the documented base + patch set (immutable). To pin explicitly (e.g.
after re-reviewing a new base):

```bash
ssh kipclip "echo 41278964ec8e3253e70d4e919dfb8e34211c543d | sudo tee /etc/tap/tap-version"
sudo systemctl start tap-update.service      # apply now
journalctl -u tap-update.service -n 30 --no-pager
```

The pin file accepts a 40-hex commit sha ONLY. Branch names and `origin/*` refs
are refused — tracking a moving branch is disabled by design. To unpin:
`sudo rm /etc/tap/tap-version` (returns to the default immutable base).

## Verify what is actually running

```bash
ssh kipclip 'cat /opt/tap/.version /opt/tap/.patches.sha256 /opt/tap/.binary.sha256'
# source sha (must be the reviewed base) / patch-set fingerprint / binary sha
ssh kipclip 'sha256sum /opt/tap/tap'          # must match .binary.sha256
```

Every update tick and every rollback re-records all three files, so the recorded
SHAs always describe the binary on disk. The health-check acceptance step logs
source + patches + binary sha after restart.

## Rollback

`tap-update.sh` keeps `/opt/tap/tap.prev` plus `.version.prev`,
`.patches.sha256.prev`, `.binary.sha256.prev` and restores all of them on
health-check failure. Manual rollback to the previous build:

```bash
ssh kipclip '
  sudo mv /opt/tap/tap.prev /opt/tap/tap
  sudo mv /opt/tap/.version.prev /opt/tap/.version
  sudo mv /opt/tap/.patches.sha256.prev /opt/tap/.patches.sha256
  sudo mv /opt/tap/.binary.sha256.prev /opt/tap/.binary.sha256
  sudo systemctl restart tap'
```

## Post-deploy measurements (first 24 hours after the fix lands)

1. `journalctl -u tap --since "24 hours ago" | grep -c RepoNotFound` — must stop
   growing; quarantined repos are no longer synced.
2. TAP retry state: `retry_count` deltas between consecutive `journalctl -u tap`
   snapshots must flatten toward 1/min per hung repo, never accelerate;
   `retry_after` values stay ≥ 1 min.
3. `journalctl --disk-usage` — journal growth must flatten (no new backoff-storm
   volume). **Do not raise the 1 GB journald cap to "fix" log noise — fix the
   source.**
4. `/api/sync/hook` error rate and `tracked_dids` / TAP repo-count delta —
   quarantine removes TAP rows for confirmed-missing tracked DIDs only;
   `tracked_dids`, mirror rows, and `missing_repos` evidence are untouched.
5. Next weekly `drift-alert` run: `errors` should drop to the unavailable-PDS
   pair (cooldown/recheck) while recoverable drift stays at 0; exit code 3 means
   "PDS errors present, nothing auto-repaired" — report it, don't call it clean.

## Shutdown `context canceled` cursor-save lines (expected, not failure)

TAP periodically persists its firehose cursor and also attempts a final save on
shutdown. When the service is stopped/restarted, the shutdown-path save races
the cancelled context and journals a line like
`failed to save cursor: context canceled`. This is EXPECTED at process teardown,
not data loss — TAP persists the cursor periodically during normal operation, so
the last periodic save is what matters. When reading TAP journals: treat
`context canceled` cursor-save lines during stop/restart as non-operational;
verify cursor freshness by the mtime of TAP's cursor file before/after the
restart, not by the absence of the shutdown line.
