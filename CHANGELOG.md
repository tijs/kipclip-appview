# Changelog

All notable changes to kipclip are documented in this file.

## [Unreleased]

## [0.10.3] - 2026-05-06

### Fixed

- `update.sh` body wrapped in a `main()` function so bash slurps the whole
  definition before invoking it. Without this, `git reset --hard origin/main`
  (added in v0.10.2) could splice old bytes (already read) with new bytes
  (re-read at the next chunk boundary) when a future commit changed the script —
  a self-rewrite race surfaced by the v0.10.x code review.
- `loadVersionInfo()` in `routes/api/system.ts` now logs a warning before
  returning FALLBACK. The original silent-FALLBACK behavior is what hid the
  v0.10.1 manifest-path bug from monitoring.

### Added

- `KIPCLIP_MANIFEST_PATH` env var override for `routes/api/system.ts` so tests
  can point at a fixture without clobbering `static/manifest.json`. Tests now
  assert exact manifest values via `tests/fixtures/manifest.test.json`, locking
  down the silent-FALLBACK regression.

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

[Unreleased]: https://github.com/tijs/kipclip-appview/compare/v0.10.3...HEAD
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
