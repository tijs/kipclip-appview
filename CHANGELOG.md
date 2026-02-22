# Changelog

All notable changes to kipclip are documented in this file.

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

[0.6.0]: https://github.com/tijs/kipclip-appview/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/tijs/kipclip-appview/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/tijs/kipclip-appview/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/tijs/kipclip-appview/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/tijs/kipclip-appview/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/tijs/kipclip-appview/releases/tag/v0.1.0
