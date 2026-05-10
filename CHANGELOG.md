# Changelog

All notable changes to kipclip are documented in this file.

## [Unreleased]

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
