# Phase 3 readiness checklist

Sign-off gate before flipping DNS from Deno Deploy to the box (plan 004 R5).

The flip cannot proceed until every line in this checklist is checked off and
the operator has signed at the bottom.

## Pre-flight code state

- [ ] Plan 004 U1, U2, U3 shipped to main and deployed to both Deno Deploy and
      the box.
- [ ] `MIRROR_DUAL_WRITE=on` set in `/etc/kipclip/app.env` on the box only (NOT
      on Deno Deploy).
- [ ] `LOCAL_DB_URL=file:/var/lib/kipclip/mirror.db` set on the box.
- [ ] App on the box logs
      `✅ Local libSQL initialized at file:/var/lib/kipclip/mirror.db` on boot.
- [ ] App on Deno Deploy logs no local DB init (logically: `localDb` null,
      `mirrorWriteEnabled() === false`).

## Backups

- [ ] `deploy/systemd/restic-backup.service` + `.timer` installed and enabled on
      the box. Verify with `systemctl status restic-backup.timer`.
- [ ] At least three consecutive nightly snapshots exist on the Storage Box.
      Verify with `restic snapshots --compact`.
- [ ] **Restore drill executed end-to-end** within the last 7 days. Recorded in
      `restic-restore-runbook.md` RTO table.
- [ ] `restic check` passes on the repo.

## Drift verification

- [ ] `scripts/mirror-drift-check.ts` ran on the box at the end of the 48-hour
      observation window. Output: zero drift across all tables.
- [ ] Per-DID counts match for every tracked DID (no DID has rows in only one
      store).

## Forced-outage drills

Each drill must complete with no user-visible 5xx errors. Sentry warnings are
expected and required — that's how we know the fallback fired.

- [ ] **Local libSQL outage drill.** Stop libSQL access (e.g., rename
      `mirror.db` to `mirror.db.bak` and restart app). Confirm:
  - [ ] `/api/initial-data` returns 200.
  - [ ] `/api/bookmarks` returns 200.
  - [ ] `/api/tags` returns 200.
  - [ ] Sentry shows `mirror read fallback: local→turso` warnings.
  - [ ] Restore mirror.db, restart, verify reads return to local.

- [ ] **Turso outage drill.** Block Turso egress (firewall the app's outbound to
      the Turso hostname). Confirm:
  - [ ] Reads continue to serve from local libSQL (no fallback fires because
        local is healthy).
  - [ ] TAP webhook keeps writing to local; Turso writes fail with
        `mirror dual-write: turso failed` Sentry warnings.
  - [ ] Auth path (sessions on Turso) is degraded — existing logged-in users
        keep working off cookies; new logins blocked. **Acceptable.**
  - [ ] Restore Turso egress, verify dual-write resumes cleanly.

- [ ] **Both-stores outage drill** (optional but valuable). Stop local libSQL
      access AND block Turso egress. Confirm:
  - [ ] Reads gracefully degrade to PDS path for tracked DIDs (existing plan-003
        fallback fires).
  - [ ] Sentry shows both `local→turso` and the second-tier fallback signals.

## Sentry signal review

- [ ] No unexpected `mirror dual-write: turso failed` events during the 48h
      window (i.e., not caused by the operator).
- [ ] No unexpected `mirror dual-write: local failed` events at all.
- [ ] No unexpected `mirror read fallback: local→turso` events.
- [ ] Drilled signals appeared as expected and resolved when the drill ended.

## Performance baseline

Captured during normal traffic for comparison post-flip.

- [ ] p50 TTFB on `/api/initial-data` (Deno Deploy origin): ~__________ ms (from
      server-timing headers or Sentry trace).
- [ ] p95 TTFB on `/api/initial-data`: ~__________ ms.
- [ ] p50 TTFB on `/api/initial-data` from the box (use `--resolve` to hit it
      directly): ~__________ ms.
- [ ] **Box p50 < Deno Deploy p50**, proving local libSQL pays off. If not, do
      not flip.

## Operational rehearsal

- [ ] Cutover runbook (`docs/operations/phase-3-cutover-runbook.md`) reviewed
      and any open questions resolved.
- [ ] DNS provider access confirmed; can flip apex + www in under 5 min.
- [ ] Rollback procedure rehearsed: re-point DNS to Deno Deploy and verify
      recovery in under 10 min.
- [ ] On-call window scheduled — operator available for at least 4h after the
      flip to watch Sentry + traffic.

## Sign-off

- [ ] All boxes above checked.
- [ ] No open Sentry incidents related to the mirror.
- [ ] Restore drill RTO recorded.

| Field                        | Value |
| ---------------------------- | ----- |
| Operator                     |       |
| Date of sign-off             |       |
| Last drift-check timestamp   |       |
| Last restore drill timestamp |       |
| Cutover scheduled for        |       |
