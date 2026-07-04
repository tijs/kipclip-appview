# Changelog

All notable changes to kipclip are documented in this file.

## [Unreleased]

## [0.24.29] - 2026-07-04

### Fixed

- Tags containing spaces now work everywhere they are treated as exact tag
  filters. Sidebar clicks quote multi-word tags in the search query, manual
  `tag:Animated Short` input resolves against known tags, deselecting those
  filters removes the whole tag instead of duplicating it, and share links keep
  matching space-containing tag values.

## [0.24.28] - 2026-06-22

### Fixed

- Tag autocomplete in the add-bookmark popup and modal is now fully
  keyboard-driven and better at matching. Arrow keys move through suggestions
  (the list scrolls to follow), Enter adds the highlighted tag or creates a new
  one from the typed text instead of silently grabbing the first match, and
  Escape closes the list. Matches are ranked exact → prefix → word-start →
  substring (so typing "test" surfaces `test` above `abtesting`/`contest`), ties
  break by most-recently-used, the matched run is emphasized in each row, and
  the dropdown now shows every match in a bounded scrollable list rather than
  capping at five.

## [0.24.27] - 2026-06-22

### Fixed

- Duplicate detection no longer collapses distinct URLs that differ only by
  meaningful query parameters (e.g. `?page=2`, `?id=42`). Matching previously
  stripped the entire query string, so genuinely different pages on the same
  path were wrongly treated as the same bookmark. URLs are now compared with
  only known tracking parameters and the fragment removed — UTM tags (`utm_*`)
  and the major ad/click identifiers (`fbclid`, `gclid`, `gbraid`, `wbraid`,
  `dclid`, `msclkid`, `ttclid`, `twclid`, `yclid`, `igshid`) are analytics-only
  and never change the underlying content, so two links that differ solely in
  those still de-duplicate.

## [0.24.26] - 2026-06-13

### Added

- User-feedback links pointing to the public feedback board (userinput.app): a
  "Feedback" item in the account dropdown, a "feedback board" link in the FAQ's
  "Still have questions?" section, and a floating Feedback button pinned
  bottom-right on desktop (hidden on mobile to preserve screen space).

### Security

- Bumped the build's esbuild dependency to the patched `0.28.1`
  (GHSA-gv7w-rqvm-qjhr). The only remaining flagged copy is a transitive
  `esbuild@0.25.7` pinned by `@fresh/core@2.3.3` (latest), which has no upstream
  fix yet; the advisory is an npm install-time vector that does not apply under
  Deno's no-lifecycle-script, lockfile-integrity model. `deno audit` is now run
  through `scripts/audit.ts`, a wrapper that allowlists this one documented
  advisory and fails the build on any other.

## [0.24.25] - 2026-06-13

### Fixed

- Forwarding-drift audit treats an empty `TAP_DB_PATH` as unset. `??` kept an
  empty string, which opened an empty `file:` db with no `repo_records` and
  skipped every run; it now falls through to the default `/var/lib/tap/tap.db`.

## [0.24.24] - 2026-06-13

### Added

- Forwarding-drift monitor, folded into the daily `drift-alert` (05:00 UTC).
  Compares each tracked DID's mirror record count against TAP's `repo_records`
  (both local SQLite, no PDS/relay calls) and warns to Sentry when they diverge
  with an empty TAP outbox — i.e. TAP synced a repo but never forwarded its
  events to `/api/sync/hook`. It runs before the 05:30 reconcile heals the gap,
  so the underlying TAP forwarding failure stays visible instead of being
  silently papered over. This is the signal that would have surfaced the
  vicwalker.dev.br migration on day one instead of via a user bug report.
  Best-effort: skips cleanly if `tap.db` is unreadable (e.g. local dev).

## [0.24.23] - 2026-06-13

### Fixed

- Write-side PDS-migration guard. After a user migrates their repo to a new PDS,
  their existing kipclip session is still bound to the old PDS (the DPoP token
  was issued by the old PDS's auth server), so in-app writes landed on the
  dead/old repo — the reason vicwalker.dev.br's deletes "did nothing". Mutating
  requests (POST/PUT/PATCH/DELETE) now compare the session's bound PDS host
  against the DID's current PDS from its DID document; on a mismatch the request
  returns 401 and the frontend redirects to login, starting a fresh OAuth flow
  against the new PDS. Reads still serve from the mirror, so a user between
  PDSes can keep browsing. Fail-open: a PLC resolution error or timeout never
  logs anyone out (the reconciler remains the correctness backstop), and
  confirmed matches are cached for an hour to keep PLC off the write hot path.

## [0.24.22] - 2026-06-13

### Added

- Reconciling mirror sync (`scripts/reconcile-mirror.ts` + `lib/reconcile.ts`).
  Treats each tracked DID's PDS as the source of truth and repairs both drift
  directions the webhook path can't: it deletes mirror rows for records removed
  on the PDS (stale rows) and upserts records the webhook never received. The
  enroll-time backfill is upsert-only, so a dropped TAP event — relay not
  carrying a PDS, an `invalid repoOp` parse error, or an account migration —
  used to leave the mirror permanently wrong (showing deleted bookmarks and
  missing new ones). Runs as a daily systemd timer (`kipclip-reconcile.timer`,
  default reconciles only audit-divergent DIDs) and as an operator CLI (`--all`,
  `--did`, `--dry-run`). The PDS read runs before any delete, so a transient
  fetch error or wrong host can never wipe a mirror.

## [0.24.21] - 2026-05-30

### Fixed

- Auto-enroll now short-circuits for already-tracked DIDs. `POST /api/bookmarks`
  fires enrollment unconditionally (so `/save`-path users get tracked), which
  meant every bookmark write by an existing user re-ran a full 5-collection PDS
  backfill; on a slow PDS that timed out and raised a spurious "auto-enroll
  failed" Sentry error. `runEnrollment` now no-ops when the DID is already
  tracked with backfill started.

## [0.24.20] - 2026-05-23

### Fixed

- `scripts/backfill-mirror.ts` now calls `tapEnroll()` before inserting into
  `tracked_dids`, preventing DIDs from being tracked locally but invisible to
  TAP's firehose. Root cause of 7 orphaned users during May 9-10 mirror
  bring-up.

### Added

- `drift-alert.ts` compares kipclip's `tracked_dids` count against TAP's
  `/stats/repo-count` and fires a Sentry warning on mismatch.

### Changed

- Rename `TAP_WEBHOOK_SECRET` to `TAP_ADMIN_PASSWORD` everywhere. Both sides now
  use the same env var name for the same secret — the split naming was the
  direct cause of the silent-401 orphan bug on day 1.

## [0.24.19] - 2026-05-23

### Changed

- Bump runtime to Deno 2.8.0 (TypeScript compiler 6.0.3). Brings `node:crypto`
  scrypt 2.12× / `node:buffer` base64 3.07× / `node:http` 2.21× perf wins along
  the OAuth, iron-session, and PDS-fetch paths, plus a 3.66× faster cold npm
  install in CI. No app code changes required — `setTimeout` return type and
  `Deno.test()` sanitizer-default shifts didn't touch our callers.
- Bump `@libsql/client` 0.17.0 → 0.17.3 and pin `ws@8.21.0` in `deno.lock` to
  clear the `ws` advisory (GHSA-58qx-3vcg-4xpx) flagged by `deno audit`.

### Added

- `deno task audit:fix` runs `deno audit --fix` for one-shot resolution of
  third-party advisories. Documented alongside the auto-update timers in
  `deploy/release/README.md`.
- CI workflow runs `deno ci` ahead of fmt/lint/test, so any drift between
  `deno.json` and `deno.lock` fails the PR explicitly instead of slipping
  through on a stale cache.

### Ops

- `deno-update.timer` on the Hetzner box now restricts auto-updates to patch
  releases only. Minor and major bumps require an operator pin
  (`echo vX.Y.Z | sudo tee /etc/kipclip/deno-version`) so behavior-change
  releases (like 2.7 → 2.8) go through a controlled rollout rather than the
  weekly tick.
- Fix latent bug in `deno-update.sh`: the script now saves the Deno zip under
  its upstream filename (`deno-${ARCH}.zip`) so `sha256sum -c` against the
  upstream `.sha256sum` file actually resolves. The bug never fired before
  because every prior tick was a no-op (`Already on v2.7.14; nothing to do`).

### Fixed

- `tap-update.sh` silently stalled for 3+ weeks: the indigo build clone was
  shallow, causing `git fetch origin main` to skip updating
  `refs/remotes/origin/main`. The script now auto-unshallows before fetching.

### Ops

- Replace stale `deploy/tap.config.example` (YAML — TAP doesn't use YAML) with
  `deploy/tap.env.example` documenting all relevant `TAP_*` env vars.
- Enable `TAP_METRICS_LISTEN` on the box for Prometheus metrics + pprof
  visibility into backfill rate limiting and firehose processing.

## [0.24.18] - 2026-05-23

### Added

- Community Tools section on the Tools page with a link to Airglow —
  automatically bookmarks links from posts you like on Bluesky.

## [0.24.17] - 2026-05-22

### Added

- New public `GET /api/stats/monthly?months=N` endpoint returning per-month MAU
  and signups for the last N calendar months (default 12, capped at 24).
  Companion to `/api/stats`; powers the monthly bar charts on the side-business
  dashboard after its migration off the Turso mirror.

## [0.24.16] - 2026-05-20

### Changed

- Landing page hero: rewrote the subhead to lead with what kipclip does ("Save,
  tag, and share links from any device") and dropped the AT Protocol name-drop
  from above the fold — the protocol pitch still lives in the `AtprotoExplainer`
  section below. Acts on community feedback that the hero leaned on atproto too
  hard for non-technical visitors.

### Added

- New "See it in action" product-preview section on the logged-out landing page,
  between Positioning and AtprotoExplainer. Three mobile screenshots in white
  matte device frames with benefit-flavoured captions so visitors can decide
  whether kipclip is for them before going through OAuth. Images served from
  `cdn.kipclip.com/images/landing-preview-{1,2,3}.png`.

## [0.24.15] - 2026-05-17

### Changed

- Drop dead exports and break a real import cycle, surfaced by a fallow audit:
  removed unused `setUser`/`clearUser` (`lib/sentry.ts`), `requireAuth`
  (`lib/route-utils.ts`), `_clearTagCache` (`lib/tag-cache.ts` +
  `routes/api/tags.ts` re-export), a dead `getClearSessionCookie` re-export, a
  second batch of unused test-only cache reset helpers
  (`_resetTestAutoSupporters`, `_resetMentionsCache`, `_resetReviewsCache`,
  `_resetStatsCache`, `_resetSupportersCache`, `_resetTrackedPdsCache`),
  `getMigrationStatus`, `countSeenDids`, `countActiveSeenDids`, dangling
  `setMockSessionProvider`/`getMockSessionProvider` test helpers, and unused
  `PreferencesRecord` + `UpdatePreferencesResponse` types. `TAG_CACHE_TTL_MS`
  demoted from `export` to local `const`.
- Extracted `OAUTH_SCOPES` into `lib/oauth-scopes.ts` to break the
  `oauth-config.ts → route-utils.ts → session.ts → oauth-config.ts` cycle.

### Added

- `.fallowrc.json` declaring the Deno/Fresh entry points fallow can't
  auto-detect (`dev.ts`, `frontend/index.tsx`, `scripts/**`, `tests/**`) so
  future static-analysis runs report real signal instead of treating the entire
  frontend, scripts, and test suite as unreachable.

## [0.24.14] - 2026-05-16

### Fixed

- INP (Interaction to Next Paint) measurement in `frontend/perf.ts` was
  reporting fake 20–40s outliers. The PerformanceObserver was collecting every
  `event` entry above 16ms — including non-interactions (scrolls, pointermove)
  and stale events recorded while the tab was backgrounded (paused-time inflated
  `duration`). The collector now follows the spec algorithm: drop entries with
  `interactionId === 0`, group remaining entries by interactionId, take the max
  duration per interaction, and report the worst interaction. Threshold raised
  from 16ms to 40ms to match the web-vitals default. The first week of perf data
  showed an INP p95 of 1840ms — those numbers were measurement artifact; expect
  the real INP p95 to drop sharply after this ships.

## [0.24.13] - 2026-05-16

### Fixed

- Sentry `beforeSend` filter now drops Fresh `HttpError` events by `.status`
  rather than `.message`. Fresh's `HttpError(status)` constructs with an empty
  message string, so the prior `msg === "Method Not Allowed"` check never
  matched and 404/405 scanner hits were reaching Sentry as `error`-level events.
  Now any 4xx HttpError is suppressed; 5xx still surface.

### Security

- `deploy/systemd/kipclip.service` now binds the Deno server to `127.0.0.1:8000`
  via `--host 127.0.0.1`. Previously it listened on `0.0.0.0:8000`, which let
  anyone hitting the box's public IP bypass Caddy's TLS, security headers, and
  CSP. Caddy already reverse-proxies to `127.0.0.1:8000`, so no proxy config
  change is required. Operators must `sudo cp` the updated unit into
  `/etc/systemd/system/`, `sudo systemctl daemon-reload`, and
  `sudo systemctl restart kipclip` to pick up the bind change (the release
  auto-update flow only manages the `SENTRY_RELEASE` drop-in, not the main
  unit).

## [0.24.12] - 2026-05-16

### Fixed

- Silence noisy Sentry warnings on `mirror read fallback to PDS` for users with
  legitimately empty libraries. `routes/api/initial-data.ts` and
  `routes/api/bookmarks.ts` now match the existing `routes/api/tags.ts` guard:
  when the mirror branch throws `mirror_empty_fallthrough` (an expected
  control-flow exception used by the 0-rows safeguard), skip the `warning`
  capture. Real DB errors still warn.

## [0.24.11] - 2026-05-16

### Fixed

- `tracked_dids.pds_url` now refreshes automatically when AT Protocol users
  migrate their repo between PDSes. Previously the column was set at enrollment
  time and never updated; stale rows broke drift audits and any recovery path
  that hit the PDS by URL. Now patched in three layers so active users self-heal
  and inactive-user drift is caught on the daily audit:
  - `lib/session.ts` + `lib/tracked-pds-refresh.ts` — every authenticated
    request opportunistically reconciles `tracked_dids.pds_url` with
    `oauthSession.pdsUrl`. Fire-and-forget UPDATE keyed by DID, cached so only
    the first request per (process, DID) issues a write.
  - `lib/auto-enroll.ts` — re-enrollment upsert now writes
    `pds_url = excluded.pds_url` unconditionally instead of preserving the
    stored value with COALESCE, so a re-enrolled user always lands on the
    current PDS.
  - `lib/drift-audit.ts` — on a PDS fetch error, the audit re-resolves the DID
    via PLC and retries once. When the resolved URL differs, the audit persists
    it to `tracked_dids.pds_url` and reports the migration in
    `scripts/drift-alert.ts` output.

## [0.24.10] - 2026-05-16

### Fixed

- `kipclip-drift-alert.service` now runs with `--allow-sys --allow-ffi` so
  libsql's native loader (which calls `os.cpus()` to detect glibc) doesn't abort
  with `NotCapable: Requires sys access to "cpus"`. Caught by the smoke-test on
  first install; v0.24.9's timer wouldn't have produced any alerts until this
  was fixed.

## [0.24.9] - 2026-05-16

### Added

- `scripts/drift-alert.ts` +
  `deploy/systemd/kipclip-drift-alert.{service,timer}` — daily 05:00 UTC drift
  detector. Audits every tracked DID's mirror vs PDS bookmark count; emits a
  Sentry warning when any DID has PDS > mirror (recoverable drift — the
  silent-401 / TAP-not-tracking pattern). Exit codes: 0 clean, 1 drift detected,
  2 audit failed. `SuccessExitStatus=0 1` so drift signals via Sentry without
  marking the systemd unit failed; audit failure (exit 2) is the only condition
  that flags the unit.
- `lib/drift-audit.ts` — shared audit core consumed by both `audit-mirror.ts`
  (operator CLI) and `drift-alert.ts` (timer).

## [0.24.8] - 2026-05-16

### Fixed

- New bookmarks no longer disappear from the list after refresh for users whose
  DID was never tracked in TAP (the pre-auto-enroll cohort, or any user whose
  initial `/repos/add` hit the silent-401 bug fixed in v0.24.5).
  `POST /api/bookmarks` now upserts the new bookmark + annotation rows to the
  local mirror immediately after the PDS write, so the read-from-mirror path
  sees the record on the next refresh regardless of TAP state.
  `PATCH /api/bookmarks/:rkey` and `POST /api/bookmarks/:rkey/enrich` got the
  same mirror-write treatment so edits and re-enrichment land in the mirror
  without waiting for the webhook round-trip. TAP webhook re-upserts remain
  idempotent. Reported in
  [tangled.org/tijs.org/kipclip-appview#1](https://tangled.org/tijs.org/kipclip-appview/issues/1).
- `POST /api/bookmarks` also calls `autoEnrollIfNeeded` at the top of the
  handler, so users who land via `/save` (and never hit `/api/initial-data`)
  still get tracked in TAP + backfilled. Previously, only the initial-data
  endpoint triggered auto-enrollment.

## [0.24.7] - 2026-05-11

### Fixed

- `lib/plc-resolver.ts` now resolves `did:web:*` identifiers via the canonical
  `did.json` endpoint at the DID's domain (per the did:web spec) instead of
  blanket-querying plc.directory. Affects every caller of `resolveDid` —
  including `routes/api/share.ts` and `routes/share/rss.ts` (public share
  endpoints and RSS feeds for did:web users previously returned 404 because PLC
  has no entry for them) and the mirror admin scripts. did:plc resolution is
  unchanged.

### Added

- `scripts/audit-mirror.ts` — compares mirror-vs-PDS counts for every row in
  `tracked_dids` and flags divergent users for recovery.
- `scripts/audit-untracked.ts` — same shape but for DIDs in `seen_dids` that
  were never enrolled (the pre-auto-enroll cohort). Handles did:plc and did:web.
  Used to surface the 72 untracked users with PDS data that this release
  backfilled via TAP `/repos/add`.

## [0.24.6] - 2026-05-11

### Fixed

- Auto-enrollment hardening — review follow-ups to v0.24.5. `tapEnroll` and the
  PDS `listRecords` calls now run with `AbortSignal.timeout` (10s for TAP, 20s
  per page for PDS) so a hung TAP or slow-loris PDS can no longer wedge
  enrollment indefinitely with the DID stuck in the `enrollingDids` set.
- Per-DID 30s cooldown on enrollment failure prevents Sentry storm + retry storm
  during a sustained TAP/PDS outage: each DID retries at most every 30s rather
  than once per page-load.
- Sentry payload now tags the failing stage (`tapEnroll` / `backfill` /
  `trackedDids`) so operators can target recovery — TAP-enrolled-but-backfill-
  failed is recoverable via the next request after cooldown (tapEnroll is
  idempotent and listRecords re-upserts any orphan rows the webhook may have
  written in the meantime).
- `enrollingDids` set now cleared in `finally` instead of only on the error
  path, so a manual `tracked_dids` delete (e.g. forced re-enrollment) doesn't
  silently no-op the next request for that DID.
- `scripts/recover-mirror.ts` count log was printing `undefined` for every count
  because `lib/db.ts` strips column names via `Object.values(row)`. Destructure
  positionally so the operator actually sees what was recovered.
- `scripts/recover-mirror.ts` now resolves the DID's PDS via `plc.directory`
  before backfill and refuses to run on a mismatch (override with `--force`).
  Catches the operator-typo case where the wrong PDS silently returns
  `{records: []}` and the script reports `bookmarks=0` against an unrelated
  host.

### Changed

- `lib/auto-enroll.ts` reads `TAP_WEBHOOK_SECRET` at call time rather than
  module load so tests can toggle the value without re-importing. Local constant
  renamed from misleading `TAP_ADMIN_PASSWORD` to a `tapWebhookSecret()` helper.

### Added

- `tests/auto-enroll.test.ts` — regression coverage for the silent-401 bug fixed
  in v0.24.5. Pins: outbound Basic auth derives from `TAP_WEBHOOK_SECRET`;
  non-2xx from TAP prevents the `tracked_dids` write; happy path enrolls +
  backfills + stamps complete; TAP-success-then-PDS-fail leaves `tracked_dids`
  empty so the next request retries from the top.

## [0.24.5] - 2026-05-11

### Fixed

- Auto-enrollment now sends the TAP admin secret on `POST /repos/add` so new
  users actually get added to TAP's tracked set. `lib/auto-enroll.ts` previously
  read `TAP_ADMIN_PASSWORD`, which the kipclip service never exports — the
  outbound call went unauthenticated, TAP returned 401, and the error was
  swallowed as "non-fatal." `tracked_dids` got marked backfill-complete while
  TAP silently dropped the user's live firehose events. Any PDS write made after
  a user's first login (imports from external tools, direct PDS writes) never
  reached the mirror, so the appview only ever served the first page from PDS
  fallback (capped at 100 records). Fix: read `TAP_WEBHOOK_SECRET` (the same
  secret kipclip already uses for inbound webhook auth, by design shared with
  TAP) and treat a failed enroll as fatal so the next request retries instead of
  locking the user into a half-tracked state.

### Added

- `scripts/recover-mirror.ts` — one-shot admin recovery: re-runs the PDS-to-
  mirror backfill for a given DID. Run on the box when an existing tracked DID's
  mirror diverged from PDS (e.g. records imported after first login while the
  TAP enrollment bug was live).

## [0.24.4] - 2026-05-10

### Fixed

- iOS standalone PWA login: OAuth round trip now uses top-level navigation
  instead of `window.open()`. iOS escapes popups to Safari, which has its own
  cookie jar — the `sid` cookie set by the OAuth callback never reached the PWA,
  so users landed back at the homepage signed out. Top-level nav keeps the round
  trip inside the PWA webview. Android Chrome PWA still uses the popup flow
  (Chrome shares its cookie jar with the browser).
- Standalone PWA users at `/` now see the login form instead of the marketing
  homepage when no session is present. Previously a failed/missing session
  rendered `<Home />`, making post-OAuth reload look like "logged out on the
  signup page."

## [0.24.3] - 2026-05-10

### Changed

- Homepage hero now uses a pale cool gradient (`#e9efee` → cream) shared across
  the page header and hero section, so Kip's white feathers contrast against the
  background instead of dissolving into the cream palette. Downstream sections
  keep the original cream + alternating tint scheme. ContinueAsChip picks up a
  softer layered shadow with hover-lift in place of the flat `shadow-sm`.

## [0.24.2] - 2026-05-10

### Fixed

- Bookmarklet/share popup: "Sign in" button on the unauthenticated state now
  routes to `/signin` instead of `/`. The homepage redesign moved the login form
  off `/`, so the old redirect dropped users on the marketing page with no way
  back to the save flow. The redirect query is preserved so users land back on
  `/save?url=...` after authenticating.

## [0.24.1] - 2026-05-10

### Fixed

- Bookmarklet save popup: clarified that pressing Enter in the tag field creates
  a new tag. The compact `TagInput` previously hid this hint, so users thought
  only existing tags could be added. Replaced the unrelated footer note with an
  inline hint directly under the tag input.

## [0.24.0] - 2026-05-10

### Changed

- All static brand assets consolidated on Bunny CDN (`cdn.kipclip.com/images/`).
  Cloudinary references for `kip-vignette` and `kip-satchel-transparent`
  retired. The `static/images/` directory in the repo (og-card.png,
  kipclip-color.svg, kipclip-bw.svg, tangled.svg, kip-vignette.png,
  kip-satchel-transparent.png) was removed — all six files now live on the CDN.
  Single source of truth for image assets.
- og:image, twitter:image, and JSON-LD `image` switched to the CDN URL so social
  crawlers fetch from the edge instead of the box.

## [0.23.2] - 2026-05-10

### Fixed

- Static `serveFile` now reads files as raw bytes via `Deno.readFile` instead of
  `Deno.readTextFile`. The previous text-mode read mangled binary assets through
  UTF-8 replacement (412KB PNG → 755KB blob of U+FFFD), which broke external OG
  scrapers — opengraph.xyz reported the og:image as "invalid or unreachable"
  because the served bytes didn't form a valid PNG. Affects every binary path
  served through `/static/*`, `/lexicons/*`, etc; SVGs round-trip cleanly now
  too.
- Added `Content-Length` header to served files so progress-aware clients can
  pipeline reliably.

### Added

- "You find it, you kip it." slogan placed above the final-CTA "Ready to kip?"
  heading in italic coral. Light, on-brand wink at the close without competing
  with the hero H1.

## [0.23.1] - 2026-05-10

### Changed

- Social sharing card replaced with a proper 1200×630 landscape image at
  `/static/images/og-card.png` — kip mascot + wordmark + tagline + "Free · Open
  source · Hosted in the EU" microline. Fixes the awkward center-crop the old
  square 1024×1024 image got on X, Facebook, and LinkedIn feeds. Bluesky and
  Mastodon also benefit from the wider aspect ratio.
- `og:locale`, `og:image:secure_url`, and `og:image:type` added. JSON-LD `image`
  now points at the new card.

## [0.23.0] - 2026-05-10

### Added

- **`seen_dids` ledger** — persistent record of every DID that has ever signed
  in. Migration 010 creates the table and backfills it from every existing
  DID-keyed source (iron_session_storage, user_settings, tracked_dids,
  bookmarks, tags, annotations, preferences). `markSeenDid()` upserts on every
  authenticated `/api/auth/session` call (fire-and-forget). The marketing user
  count now reads from this ledger so it never drifts down when
  iron_session_storage prunes expired sessions.
- `lib/seen-dids.ts` exposes `markSeenDid()`, `countSeenDids()`, and
  `countActiveSeenDids(windowMs)` so the active-user metric (DIDs seen within a
  trailing window) is one query away when we need it.
- `seen_dids` is included in the `/api/stats` `bySource` breakdown and is the
  new primary value for `userCount`.

## [0.22.3] - 2026-05-10

### Added

- `/api/stats` now also returns a `bySource` breakdown: distinct DID counts per
  backing table (sessions, user_settings, tracked_dids, bookmarks, tags,
  annotations, preferences). Helpful for spotting drift between data sources
  without shelling onto the box.

## [0.22.2] - 2026-05-10

### Fixed

- `/api/stats` now also unions `iron_session_storage` (parsed
  `session:did:plc:...` keys), which captures every successful OAuth flow
  including users who signed in once via /save and never persisted records.
  Previous queries missed those.

## [0.22.1] - 2026-05-10

### Fixed

- `/api/stats` was massively undercounting users — the marketing "Join N people"
  line showed only ~15 against ~140 actual sign-ins. user_settings and
  tracked_dids only get rows when a session reaches `/api/initial-data`, but
  many users sign in via `/save` (bookmarklet, share target) and never hit that
  path. The query now unions DIDs across user_settings, tracked_dids, bookmarks,
  tags, annotations, and preferences — every DID-keyed table the appview
  maintains — so any user who has ever persisted anything is counted.

## [0.22.0] - 2026-05-10

### Added

- **Marketing landing page** at `/` for logged-out visitors. Hero, positioning
  ("Like Pinboard, Pocket, or Raindrop — but portable"), AT Protocol explainer
  with compatible apps (Margin, Disperse), tools sentence, reviews from
  atstore.fyi (with star ratings), Bluesky mentions via Microcosm Constellation,
  current supporters, EU-hosted block, and a final CTA. Logged-in visitors are
  unaffected — they still land on the bookmark list.
- **Frontend route `/signin`** renders the existing Login UI. Header CTAs and
  bookmarklet/share-target 401 redirects all point here.
- **Reusable backend libs** with shared 24h cached-fetch helper:
  - `lib/reviews.ts` + `/api/reviews` — formal atstore.fyi review records.
  - `lib/mentions.ts` + `/api/mentions` — Bluesky posts linking to kipclip.com,
    via Microcosm Constellation + bsky appview.
  - `lib/supporters.ts` + `/api/supporters` — atprotofans supporters hydrated
    through bsky `getProfiles`.
  - `lib/stats.ts` + `/api/stats` — total user count for "join N people" social
    proof.
  - `lib/cached-fetch.ts` — generic TTL cache with request coalescing, fail-open
    behaviour, and stale-cache fallback when upstream is down.
- **FAQ page CTA** — sign-up section appears at the bottom for logged-out
  visitors so they can convert without backtracking.
- **Support page extras**: "Current supporters" tile grid (mirrors the homepage
  section) and a "Short on cash? Leave a review." card linking to the kipclip
  listing on atstore.fyi.
- **Press page assets** updated to use the cleaned-up kipclip color and B&W
  logomarks from cozylittle.house/atmologos, served locally from
  `/static/images/`.
- **SEO and structured data** in `frontend/index.html`: revised title and
  description anchored on Pinboard/Pocket/Raindrop, keywords meta, canonical,
  `robots` directive, and a JSON-LD `SoftwareApplication` block.

### Changed

- Homepage `/` now serves the marketing landing for logged-out visitors;
  logged-in visitors continue to see the bookmark list as before.
- Header CTAs (`Get started`, `Sign in`) and the final-CTA pair both link to
  `/signin` so anyone with an existing Atmosphere account isn't bounced through
  the create-account flow.
- All site-facing GitHub links now point at Tangled
  (`https://tangled.org/tijs.org/kipclip-appview`). README CI badge unchanged.
- `Cache-Control` on the public marketing endpoints lowered to
  `public, max-age=60, stale-while-revalidate=600` so updates surface in
  browsers within a minute. Server-side 24h cache still authoritative for
  upstream load.
- `PageShell` back-link adapts to session: "Back to Bookmarks" when logged in,
  "Back to Home" otherwise.

## [0.21.0] - 2026-05-09

### Added

- **Tag sidebar search**: always-visible search input at the top of the desktop
  sidebar and the mobile horizontal bar. Filters the tag list live by
  case-insensitive substring match. `type="search"` for native clear; ESC clears
  and blurs.
- **Recent tags zone**: surfaces the last 8 tags you touched (filtered, applied
  to a bookmark, removed) above the alphabetical list, with a "RECENT" label on
  desktop and recents-leading on the mobile bar. Updates from sidebar clicks and
  any tag input — covers AddBookmark, EditBookmark, and BulkTagModal via the
  shared `TagInput` component. Persisted per-device in localStorage under
  `kipclip:recent-tags`. No backend changes.

## [0.20.0] - 2026-05-09

### Removed

- **Turso remote dual-write and Deno Deploy warm-standby**: removed `remoteDb`,
  `sessionDb`, `mirrorWrite`, and all Turso/Deno Deploy infrastructure. Session
  and mirror data now write exclusively to the primary local SQLite on the
  Hetzner box. Data verified complete before removal (265/265 sessions matched;
  primary had more mirror rows than Turso backup).

## [0.19.2] - 2026-05-09

### Fixed

- **Tags empty for fresh users**: new tags created immediately after
  auto-enrollment were invisible until TAP delivered the event. Tag
  create/update/delete now synchronously writes to the local mirror before
  returning the HTTP response, closing the same-session race window.
- **Tag cache served stale data for mirror-fallback users**: GET /api/tags now
  only reads from and stores to the in-process cache when the user is NOT being
  served from the mirror, preventing a stale PDS-fallback snapshot from
  shadowing fresh mirror data.
- **Merge-duplicates missed cache invalidation**: POST
  /api/tags/merge-duplicates now invalidates the tag cache after merging, so the
  next GET reflects the merged state immediately.
- **SQLite PRAGMA synchronous=NORMAL**: added documentation comment noting the
  OS-crash durability trade-off accepted for this workload.

### Changed

- Extracted in-process tag cache to `lib/tag-cache.ts` (was inline in
  `routes/api/tags.ts`); tag mutations now log mirror-write failures to Sentry
  instead of silently swallowing them.

## [0.19.1] - 2026-05-09

### Removed

- `POST /api/sync/track` endpoint removed. The endpoint was never reachable from
  the UI (no frontend caller existed) and its design was incorrect — it opened
  the mirror gate by writing `backfill_started_at` without running a PDS
  backfill. Auto-enrollment (`lib/auto-enroll.ts`) supersedes it correctly: full
  backfill first, then both timestamps written atomically. Also removes
  `insertTrackedDidForEnrollment` (its only caller) and all related tests.

## [0.19.0] - 2026-05-09

### Added

- **Auto-enrollment**: all users are now automatically enrolled in the local
  mirror on their first `/api/initial-data` request when `MIRROR_MODE=read`.
  Previously the mirror architecture was built but never activated for new users
  — only the operator's own DID was tracked. `lib/auto-enroll.ts` runs a full
  PDS backfill in the background (all 5 collections), then atomically inserts
  the `tracked_dids` row with both `backfill_started_at` and
  `backfill_complete_at` set so the mirror gate opens only after data is ready.
  Users never see a "syncing" state with 0 bookmarks.

### Fixed

- Bookmarks are now sorted newest-first by `createdAt` in the UI. Previously,
  PDS-fallback reads returned records in ascending rkey order, which placed
  recently-added bookmarks (TID rkeys, e.g. `3ml...`) at position ~1700 in a
  3000-bookmark library — invisibly behind all older hex-rkey imports. Mirror
  reads were already `createdAt DESC`; this change makes PDS fallback
  consistent.
- Empty-mirror safeguard now falls through to PDS for any tracked DID returning
  0 bookmarks, regardless of `syncing` state. Previously the guard was skipped
  while `syncing=true`, meaning a DID enrolled via the operator backfill script
  before `backfill_complete_at` was stamped could open the mirror gate with an
  empty mirror.
- `touchTracked` in the TAP webhook handler no longer inserts a new
  `tracked_dids` row for DIDs that have not been explicitly enrolled in mirror
  sync. Previously, the first live TAP event for an untracked DID would create a
  row with `backfill_started_at = now`, opening the mirror gate when the mirror
  contained only a single record — causing all other bookmarks to disappear from
  the UI. `touchTracked` now issues an UPDATE-only query that is a no-op for
  untracked DIDs.
- Restored `backfill_complete_at` completion signal: `touchTracked` now stamps
  `backfill_complete_at` on the first live (post-backfill) event for enrolled
  DIDs using `COALESCE` so the timestamp is never regressed. Previously this was
  inadvertently removed alongside the INSERT footgun.
- Migration 009 backfills `backfill_complete_at` for enrolled DIDs that were
  stuck in permanent `syncing=true` state due to the missing completion signal.
- `/api/sync/track` now calls `insertTrackedDidForEnrollment` (INSERT OR IGNORE)
  instead of `upsertTrackedDid` (INSERT ON CONFLICT UPDATE), making the
  enrollment intent explicit and preventing re-enrollment from clobbering a
  mid-backfill row.
- `MIRROR_WEBHOOK_ACK_ASYNC` env var is now read per-request instead of at
  module load, allowing tests to toggle it between cases.
- Added 14 webhook regression tests covering all collection types, all event
  actions, identity events, and the `backfill_complete_at` completion signal.

## [0.18.2] - 2026-05-08

### Fixed

- Migration 005 backfills `created_at` and `updated_at` columns on
  `iron_session_storage` for installs that were migrated from Turso before
  `atproto-storage@1.1.0` added those columns. Prevents login failures on
  installs where the table was created with the old 3-column schema.
- `migrate-sessions-to-local.ts` now uses the current 5-column schema
  (`expires_at TEXT`, `created_at`, `updated_at`) matching
  `SQLiteStorage@1.1.0+`.
- Updated `@tijs/atproto-oauth` to 2.10.2 and `@tijs/atproto-storage` to 1.2.0.
  `SQLiteStorage.init()` now self-heals tables missing the new columns.
- OAuth sessions are now dual-written to Turso when `MIRROR_DUAL_WRITE=on` is
  set, keeping the Deno Deploy fallback warm.

## [0.18.1] - 2026-05-08

### Fixed

- `gcSeenWebhookEvents` now runs after migrations complete instead of at module
  import time. Eliminates the `no such table: seen_webhook_events` warning on
  cold boot before the schema is initialized.

## [0.18.0] - 2026-05-08

### Changed

- Primary database is now a local SQLite file on the Hetzner box (`DATABASE_URL`
  env var, defaulting to `file:.local/kipclip.db`). All reads, OAuth sessions,
  user settings, and mirror tables are served from local SQLite. Turso remote
  (`TURSO_DATABASE_URL`) is now an optional warm-standby mirror backup only —
  enabled by `MIRROR_DUAL_WRITE=on`. Sessions previously stored in Turso are
  copied to local SQLite via `scripts/migrate-sessions-to-local.ts`.

### Fixed

- Static import of `@std/dotenv` at top of `main.ts` (previously dynamic inside
  an `if` branch). The dynamic form was excluded from Deno Deploy's module graph
  at bundle time, causing login to hang and bookmark saves/deletes to fail on
  the Deno Deploy warm standby.

## [0.17.0] - 2026-05-08

### Added

- Live event WebSocket channel at `/api/live`. After a user signs in, the SPA
  opens a WebSocket back to the server; every TAP webhook event applied to the
  mirror for that DID is pushed to the open tab as a JSON message
  (`{ type, collection, rkey, op, indexedAt }`). The client coalesces bursts
  into 100ms batches and reconnects with 1s → 30s exponential backoff. Closes
  while the document is hidden and re-opens on `visibilitychange`.
  Authentication uses the existing OAuth session cookie (same-origin upgrade
  carries the cookie). Auth-less upgrades return 401.

### Fixed

- The tag sidebar / tag-count list no longer goes stale after a bookmark edit
  removes a tag. Bookmark, tag, annotation, and preferences events arriving over
  the live channel now drive a focused refetch of the affected slice (tags /
  bookmarks / preferences). Multi-device edits and PDS-side mutations from
  another client also propagate without manual refresh.

### Changed

- Upgraded `@fresh/core` from 2.2.0 to 2.3.3.
- `App` now constructed with `trustProxy: true`. Fresh applies
  `X-Forwarded-Proto` and `X-Forwarded-Host` to `ctx.url` itself, so the
  hand-rolled proxy header parsing in `lib/oauth-config.ts` was removed.
  `initOAuth` now takes a `URL` (`ctx.url`) instead of a `Request`.
- OAuth client is now eagerly initialised at startup when `BASE_URL` is set in
  the env. The per-request init middleware only registers as a fallback when
  `BASE_URL` is unset (e.g. local dev without ngrok pinning). Both production
  surfaces (Hetzner box, Deno Deploy) set `BASE_URL`, so the init middleware no
  longer runs on the hot path.

### Security

- `/api/sync/hook` is now wrapped with Fresh's `ipFilter` middleware
  (`allowList: ["127.0.0.1", "::1"]`) and the redundant in-handler
  `isLocalhostHostname` check is gone. On the Hetzner box this is
  belt-and-suspenders behind Caddy's existing 403 on public hosts. On Deno
  Deploy, where there is no Caddy in front, this **closes a real attack
  surface**: previously the only gate was the handler's Basic-auth check; an
  attacker who learned `TAP_WEBHOOK_SECRET` could feed events into the warm
  standby. Now any request from a non-loopback peer is rejected before the
  handler runs. (TAP itself only fires to the box, so legitimate traffic is
  unaffected.) Note: on the box, Caddy proxies external traffic to localhost, so
  all requests reaching the app appear as `127.0.0.1` — the ipFilter cannot
  distinguish TAP from a Caddy-forwarded user request there. The Basic-auth
  check inside `handleWebhookRequest` remains the actual TAP-vs-user gate on the
  box.

## [0.16.3] - 2026-05-08

### Fixed

- Reading-list re-enrichment no longer competes with the initial-load streaming
  flush for network bandwidth. The 500ms gaps between batched flushes look idle
  to the browser, so `requestIdleCallback` was firing enrich requests at ~900ms
  while streaming was still running until ~2s. Effect now also gates on
  `!isSyncing`, so enrichment only kicks in after pagination has fully settled.

## [0.16.2] - 2026-05-08

### Changed

- Reading-list re-enrichment now schedules its background batches via
  `requestIdleCallback` (with a 5s timeout fallback) instead of a fixed 1s
  `setTimeout`. The browser only runs the enrich pass during idle windows, so it
  can no longer compete with active scrolling or typing for main-thread time.
  Falls back to setTimeout on browsers without rIC support.

## [0.16.1] - 2026-05-08

### Changed

- Mirror page size for the initial-load streaming fetcher bumped from 50 to 200.
  Cuts the background pagination round-trip count from ~61 pages to ~16 on a
  3000-bookmark library, shaving ~3s off background streaming time. Local sqlite
  handles 200-row scans in under 30ms. PDS-fallback callers still cap at 100
  (rate-limit + listRecords ceiling).

## [0.16.0] - 2026-05-08

### Changed

- Initial page load streams the first bookmark page to the UI as soon as it
  lands, rather than waiting for every page to paginate before rendering.
  Background pagination then fills the rest of the library in 500ms-batched
  flushes. On a 3000-bookmark library this drops time-to- first-bookmark from
  ~5s to ~700ms (cold cache).

### Fixed

- Reading-list re-enrichment no longer fires the same bookmark forever when the
  URL has no og:image. Server-200-with-no-image now counts as a failed attempt
  against the 3-retry cap, eliminating an ~60-call N+1 storm during initial
  load.
- BookmarkList no longer remounts the visible cards on every grow during
  streaming. The incremental-render reset now only fires when the total list
  shrinks (filter applied), not when bookmarks arrive.

### Added

- Server-Timing headers on `/api/initial-data` and `/api/tags` (session,
  mirror-decision, supporter, mirror-bookmarks/extras, pds-\* spans). Visible in
  browser DevTools → Network → Timing.
- New `/api/metrics` beacon endpoint that accepts a single per-page-load perf
  bundle from the frontend (web vitals + per-route Server-Timing totals +
  bookmark count) via `navigator.sendBeacon`. Logged as a structured
  `[perf] {...}` JSON line to journalctl on the box.

## [0.15.4] - 2026-05-07

### Added

- "Syncing your data" pill in the header during first-login backfill, so a new
  user opening kipclip while their bookmarks are still being mirrored sees a
  clear signal instead of a blank list.

### Fixed

- Concurrent edits on the same bookmark or tag from different tabs/devices no
  longer silently overwrite each other. PUT bookmark, refresh metadata, PUT tag,
  and bulk tag operations now use AT Protocol's `swapRecord` conditional write —
  the second writer gets a `409 concurrent_edit` instead of clobbering the first
  writer's changes.

## [0.15.3] - 2026-05-07

### Fixed

- A Turso outage no longer 500s every edit path. The mirror's sync-status lookup
  now degrades to a direct PDS read instead of bubbling the Turso error up
  through the helpers.

### Changed

- Bulk tag operations now do one mirror sync-status lookup per request instead
  of one per item, via a 1s cache. A 100-bookmark bulk used to fan out ~200
  redundant Turso queries; now it does ~1.

## [0.15.2] - 2026-05-06

### Changed

- Edit and delete paths (PUT bookmark, refresh metadata, tag rename / delete /
  usage, bulk tag add/remove) now read from the local mirror first and only hit
  the user's PDS when the mirror genuinely doesn't have the record. Cuts PDS
  reads on a heavy editor session to roughly the number of writes.

## [0.15.1] - 2026-05-06

### Fixed

- Reverted the trailing `""` argument experiment in
  `deploy/release/kipclip.sudoers`. It required a literal empty arg instead of
  restricting trailing args, so `sudo systemctl
  daemon-reload` was rejected.
  Sudoers default with explicit args is already exact-arg match — the original
  spec without `""` is correct.

## [0.15.0] - 2026-05-06

### Security

- Webhook receiver now also accepts `Authorization: Basic admin:<secret>` to
  match TAP's outbound webhook auth shape (in addition to `Bearer <secret>`).
  Username must be `admin`.

## [0.14.0] - 2026-05-06

### Security

- Subresource Integrity (sha384) on the bundle script tag. Browsers refuse to
  execute the bundle if the bytes don't match the digest.
- Content-Security-Policy at the Caddy edge in Report-Only mode. Violations log
  to `/api/csp-report`. Allowlists `'self'` plus Bluesky API, atprotofans,
  simpleanalytics, esm.sh.
- X-Content-Type-Options, Referrer-Policy, and Permissions-Policy headers now
  also set at the Caddy edge (in addition to the app middleware) to cover static
  and 403 responses.

## [0.13.0] - 2026-05-06

### Security

- Webhook receiver enforces an Authorization-header check when
  `TAP_WEBHOOK_SECRET` is set. Constant-time compare. Defense-in-depth behind
  the Caddy localhost-only rule.

## [0.12.0] - 2026-05-06

### Security

- Sudoers grants tightened to exact-arg match.
- Env file permissions audit script (`deploy/release/check-env-perms.sh`) added
  and run during bootstrap.

### Removed

- `sha` and `builtAt` from the public `/api/version` response. Only `version` is
  returned now. The About page no longer displays them.

## [0.11.0] - 2026-05-06

### Added

- Webhook replay protection: duplicate TAP event ids are rejected without
  reprocessing. Defends against captured-payload replay (e.g., re-delivering a
  delete event after the user re-created the record).
- `/api/csp-report` endpoint accepts CSP violation reports.
- `actor-typeahead` script is now self-hosted with SRI integrity, replacing the
  runtime fetch from esm.sh.

### Changed

- The release tick now rolls the `current` symlink back to the previous release
  when the post-restart health check fails. Previously the symlink stayed on the
  broken release.

## [0.10.3] - 2026-05-06

### Fixed

- `/api/version` now logs a warning when the manifest read fails, instead of
  silently returning `unknown`.
- Hardened the release script against a self-rewrite race during in-place
  updates.

## [0.10.2] - 2026-05-06

### Fixed

- `update.sh` now self-syncs the source clone's working tree to `origin/main` on
  every tick. Without this, the release script ran from its bootstrap-time copy
  forever — fixes shipped via tag but the timer kept executing the frozen
  version, so the v0.10.1 sha-fix never actually took effect.

## [0.10.1] - 2026-05-06

### Fixed

- `/api/version` returned `unknown` because `routes/api/system.ts` resolved
  `static/manifest.json` relative to its own location (`routes/api/`), two
  directories deep from the repo root. Read via `Deno.readTextFile` from the
  release CWD instead.
- Build-time `sha` field was `unknown` in production because release dirs are
  materialised via `git archive | tar -x` and have no `.git`. The release script
  now pre-resolves the sha in the source clone and passes it via `KIPCLIP_SHA`.

## [0.10.0] - 2026-05-06

### Added

- Pull-based release flow on the production box: a 60s systemd timer
  (`kipclip-release.timer`) polls GitHub for the latest `v*` tag, builds in a
  per-tag release directory, and atomic-swaps a `current` symlink. Replaces the
  operator-laptop rsync deploy. Releases are now triggered by `git tag` +
  `git push --tags` from any machine with push perms.
- `/api/version` and `/api/health` endpoints surface the running release tag,
  sha, and build timestamp so prod-vs-local is unambiguous.
- Footer + About now show the running version, linking to the GitHub release
  page.
- Sentry events tag the running release via `SENTRY_RELEASE`, so production
  errors attribute to a specific tag in the Sentry UI.
- Pin override (`/etc/kipclip/release-pin`) for incident pinning and
  no-force-push rollback.
- Release runbook at `deploy/release/README.md`.

### Changed

- `deploy/deploy.sh` is now staging-only; refuses to run against production
  hostnames. Production uses the pull-based release flow exclusively.

### Removed

- Browser-side IndexedDB cache + sync/diff layer
  (`frontend/cache/{db,sync,diff}.ts`). AppView mirror now serves bookmarks from
  local libSQL on the box, so the client-side cache no longer adds value. Bundle
  is ~4 KB smaller.

### Changed

- Initial bookmark load and refresh now fetch directly from `/api/initial-data`
  with unified cursor pagination and rate-limit-aware throttling on the
  PDS-fallback path
- Tab-focus and pull-to-refresh share a single in-flight guard so concurrent
  refreshes can no longer race each other
- Logout no longer attempts to clear an IndexedDB cache that no longer exists

### Fixed

- AppView outage now surfaces a clear error screen with a retry button instead
  of silently rendering an empty bookmark list
- Mid-pagination refresh failures dismiss the in-progress sync toast and surface
  an error toast instead of leaving the progress toast stuck

### Notes

- The "N bookmarks updated" cross-device awareness toast was retired alongside
  the diff layer. A server-side "last viewed" indicator may reintroduce it in a
  future release.

## [0.9.0] - 2026-04-17

### Fixed

- Shared collections now return all matching bookmarks, not just matches found
  within the first 100 records on the owner's PDS

### Added

- Share button on public collection pages (Web Share API with clipboard
  fallback) so any visitor can share a collection, not just its owner
- Regression test coverage for shared collection pagination and SSRF hardening

### Changed

- The owner's Share collection button now navigates directly to the collection
  page instead of invoking the share sheet inline
- All public share endpoints route through a hardened PDS client with SSRF
  checks, page and deadline caps, per-request timeouts, and 429 backoff

## [0.8.0] - 2026-04-17

### Added

- Supporter gating via atprotofans.com: import is now unlocked for kipclip
  supporters, with supporter status read from the user's PDS
- Dismissible support banner, supporter badge in the user menu, and a dedicated
  Settings → Supporter tab
- Shared `Button`, `Tag`, and `HeartIcon` components for consistent styling
  across supporter surfaces

### Changed

- Unified design language: coral CTAs, teal selection state, warmer palette
- Import jobs stamp supporter verification at prepare-time so mid-import PDS
  flakes no longer 403 an in-progress job
- 403 responses on gated endpoints now include `upgradeUrl` and `statusUrl` so
  clients can guide users to unlock the feature

### Fixed

- Supporter check hardened: byte-capped PDS response reader, pagination cap,
  negative caching, and refresh cooldown protect against flaky/hostile PDSes

## [0.7.0] - 2026-03-20

### Changed

- Incremental sync: only fetch new bookmarks instead of re-paginating the entire
  collection on each load
- PDS rate limit awareness: backend forwards rate limit headers, frontend pauses
  sync when limits are low

## [0.6.1] - 2026-02-22

### Added

- Wayback Machine link in bookmark detail view for archived/fallback access

## [0.6.0] - 2026-02-22

### Added

- Annotation sidecar records with notes and bookmark detail modal
- Card/list view toggle for bookmarks
- Date format setting (US, EU, EU dot, ISO, text)
- Duplicate URL detection for bookmark creation
- Tag input in bookmark creation popups
- Local search filtering for bookmarks and reading list
- Preview images in reading list
- Full-card action overlay for bookmark cards
- Bluesky quick-connect on redesigned login page
- OAuth-based account registration with prompt=create
- Create account page with PDS provider options (Bluesky, Selfhosted, Teal Town)
- Dependabot and `deno audit` in CI and quality task

### Changed

- Redesigned login page with Atmosphere connect flow
- Friendlier language and registration flow for new users
- Replaced local actor-typeahead with `@tijs/actor-typeahead` from JSR
- Unified detail modal button colors with brand palette

### Fixed

- Failed enrichments can now be retried
- Bookmark edit no longer drops favicon and image
- Auto-repair missing favicons on page load
- Favicon enrichment falls back to origin/favicon.ico
- Favicon regex no longer matches data-base-href
- Expected session errors handled without Sentry noise
- Retry logic for transient Turso errors during migrations
- Retry on Turso "connection not opened" during cold start
- Lexicon schema fixes for `com.kipclip.tag` and annotation fields

## [0.5.0] - 2026-01-15

### Added

- Reading list feature with configurable tag filter
- Instapaper integration with automatic article sending
- PWA support with popup OAuth and share target
- iOS home screen instructions on Tools page

### Changed

- Granular OAuth scopes instead of transition:generic
- Responsive header: hide "kipclip" text on mobile
- Updated all dependencies and added lockfile

## [0.4.0] - 2025-12-07

### Added

- Security hardening: SSRF protection, output sanitization, security headers
- Comprehensive test suite with mock dependencies
- Robots.txt endpoint
- Content-hashed frontend bundles with immutable caching
- Sentry error tracking

### Changed

- Migrated from Hono to Fresh 2.x framework
- Migrated to Deno Deploy
- Migrated database to Turso
- Moved static assets to Bunny CDN
- Pre-built frontend bundle with React 19
- BASE_URL now optional (derived from incoming requests)
- Routes reorganized into domain-specific modules

## [0.3.0] - 2025-11-29

### Added

- Handle autocomplete on login page
- Combined initial-data endpoint to prevent token refresh race conditions
- `/api/auth/session` endpoint for frontend session check
- CI test workflow with badge
- Comprehensive error logging for OAuth session issues

### Changed

- Migrated to framework-agnostic `@tijs/atproto-oauth` (away from Hono-specific
  library)
- Added `@tijs/atproto-sessions` for session storage
- Removed unused Drizzle ORM dependency

### Fixed

- Iron-session cookie refresh
- Token refresh race condition

## [0.2.0] - 2025-11-01

### Added

- Bookmark collection sharing with Open Graph tags
- RSS feeds for shared bookmark collections
- FAQ page with login messaging
- Clickable handles

### Fixed

- Login redirect parameter preservation in bookmarklet flow
- Session refresh and expired token handling
- Save component login link routing

## [0.1.0] - 2025-10-19

### Added

- Bookmark management using AT Protocol (community.lexicon.bookmarks.bookmark)
- Tag system with create, edit, and delete (com.kipclip.tag)
- Tag filtering with AND logic
- Drag-and-drop tagging
- Bookmark edit modal with centralized state management
- Bookmarklet for saving from anywhere
- iOS Shortcut integration
- Open Graph and Twitter Card metadata
- About page with Ko-fi support link
- Responsive mobile and desktop layouts
- Kip logo and "Find it, Kip it" tagline

[Unreleased]: https://github.com/tijs/kipclip-appview/compare/v0.15.1...HEAD
[0.15.1]: https://github.com/tijs/kipclip-appview/compare/v0.15.0...v0.15.1
[0.15.0]: https://github.com/tijs/kipclip-appview/compare/v0.14.0...v0.15.0
[0.14.0]: https://github.com/tijs/kipclip-appview/compare/v0.13.0...v0.14.0
[0.13.0]: https://github.com/tijs/kipclip-appview/compare/v0.12.0...v0.13.0
[0.12.0]: https://github.com/tijs/kipclip-appview/compare/v0.11.0...v0.12.0
[0.11.0]: https://github.com/tijs/kipclip-appview/compare/v0.10.3...v0.11.0
[0.10.3]: https://github.com/tijs/kipclip-appview/compare/v0.10.2...v0.10.3
[0.10.2]: https://github.com/tijs/kipclip-appview/compare/v0.10.1...v0.10.2
[0.10.1]: https://github.com/tijs/kipclip-appview/compare/v0.10.0...v0.10.1
[0.10.0]: https://github.com/tijs/kipclip-appview/compare/v0.9.0...v0.10.0
[0.9.0]: https://github.com/tijs/kipclip-appview/compare/v0.8.0...v0.9.0
[0.8.0]: https://github.com/tijs/kipclip-appview/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/tijs/kipclip-appview/compare/v0.6.1...v0.7.0
[0.6.1]: https://github.com/tijs/kipclip-appview/compare/v0.6.0...v0.6.1
[0.6.0]: https://github.com/tijs/kipclip-appview/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/tijs/kipclip-appview/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/tijs/kipclip-appview/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/tijs/kipclip-appview/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/tijs/kipclip-appview/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/tijs/kipclip-appview/releases/tag/v0.1.0
