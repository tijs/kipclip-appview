# Phase 3 cutover runbook

DNS flip from Deno Deploy to the Hetzner box. Run only after every box in
`docs/operations/phase-3-readiness.md` is checked off and signed.

## Decision summary

| Item               | Value                                       |
| ------------------ | ------------------------------------------- |
| Origin before flip | Deno Deploy (`kipclip.com` → Deno's CDN)    |
| Origin after flip  | Hetzner box (`kipclip.com` → box public IP) |
| Sessions           | Stay on Turso (no migration)                |
| user_settings      | Stay on Turso (no migration)                |
| import_jobs        | Stay on Turso (no migration)                |
| Mirror reads       | Local libSQL on box (with Turso failover)   |
| Mirror writes      | TAP webhook dual-writes (local + Turso)     |

## Pre-flip (T-24h)

- [ ] Confirm phase-3-readiness checklist signed.
- [ ] Notify users (status page banner or social post: "brief ~5 min DNS
      propagation window").
- [ ] **Drop DNS TTL on `kipclip.com` and `www.kipclip.com` to 60s.** Wait for
      propagation (`dig +short kipclip.com` from multiple regions; or use
      https://dnschecker.org).
- [ ] Verify Caddyfile on the box already has `kipclip.com` and
      `www.kipclip.com` blocks (this lands ahead of the flip — see
      `deploy/Caddyfile`). Caddy will provision certs automatically when DNS
      resolves to the box.

## Pre-flip (T-1h)

Smoke-test the box behind the existing apex IP via `curl --resolve`:

```bash
BOX_IP=$(dig +short staging.kipclip.com | tail -1)
echo "Box IP: $BOX_IP"

# Hit production apex on the box without DNS flip.
curl -sI --resolve kipclip.com:443:$BOX_IP https://kipclip.com/
curl -s  --resolve kipclip.com:443:$BOX_IP https://kipclip.com/api/initial-data \
  -H "Cookie: <a real session cookie>"
```

- [ ] Box returns 200 on `/` and 200 on `/api/initial-data` for a real session.
- [ ] TLS cert valid (`curl -vI`).
- [ ] No errors in `journalctl -u kipclip -n 50`.

## Flip (T-0)

```bash
# Update DNS records — exact steps depend on the registrar.
# Set A (and AAAA if available) for both kipclip.com and www.kipclip.com
# to the box's public IPv4 (and IPv6) address.
```

- [ ] Set apex A record → box public IPv4.
- [ ] Set apex AAAA record → box public IPv6.
- [ ] Set `www` A/AAAA records → box public IPv4/IPv6.
- [ ] Optional: remove the old Deno Deploy CNAME / A records once you confirm
      the new ones resolve.

## Watch (T+0 to T+30min)

Run these in parallel terminal windows:

```bash
# Live request log on the box.
sudo journalctl -u kipclip -f

# Live access log.
sudo tail -f /var/log/caddy/kipclip.com.log
```

- [ ] Traffic shifts from Deno Deploy to box over ~5–10 min as DNS caches
      expire. Confirm via `dig` from multiple regions.
- [ ] Sentry: zero new error-class events. Existing dual-write warnings OK if
      they were present pre-flip.
- [ ] p50 TTFB on `/api/initial-data` (measured via Sentry trace or
      server-timing) drops materially vs Deno Deploy baseline.
- [ ] No 5xx spikes in Caddy log.
- [ ] No `mirror dual-write: local failed` events.

## Watch (T+30min to T+24h)

- [ ] Monitor Sentry hourly for the first 4h, then every 6h until 24h.
- [ ] Verify daily restic backup runs and produces a snapshot at 04:00 UTC the
      morning after.
- [ ] Run `scripts/mirror-drift-check.ts` once at T+12h. Expect zero drift.

## Rollback (any time within 24h)

If anything breaks (5xx spike, unexpected Sentry signal, latency regression),
roll back DNS:

```bash
# Revert apex + www to the prior Deno Deploy targets.
```

- [ ] Re-point `kipclip.com` and `www.kipclip.com` back to Deno Deploy origin
      records.
- [ ] Wait for TTL (60s) to expire from caches.
- [ ] Verify Deno Deploy is serving (it stays alive — never paused).
- [ ] Set `MIRROR_DUAL_WRITE=off` on the box and restart so the box stops
      dual-writing while the issue is investigated. Local mirror stays intact
      for next attempt.
- [ ] Update Sentry, file an incident, schedule next attempt.

## Post-flip cleanup (T+72h, only after fully clean)

- [ ] Raise DNS TTL on apex + www back to a reasonable value (3600s).
- [ ] Optionally pause Deno Deploy origin (don't delete — keep as warm standby
      while phase 4 is in flight).
- [ ] Schedule phase 4 plan: drop IDB cache + frontend sync/diff machinery
      (`frontend/cache/{db,sync,diff}.ts`).

## Sign-off

| Field                                | Value    |
| ------------------------------------ | -------- |
| Operator                             |          |
| Flip start time (UTC)                |          |
| First box-served request observed at |          |
| p50 TTFB pre-flip / post-flip        | /        |
| Rollback fired?                      | yes / no |
| Final cutover confirmed at           |          |
