# kipclip

[![Test](https://github.com/tijs/kipclip-appview/actions/workflows/test.yml/badge.svg)](https://github.com/tijs/kipclip-appview/actions/workflows/test.yml)
[![codecov](https://codecov.io/gh/tijs/kipclip-appview/graph/badge.svg)](https://codecov.io/gh/tijs/kipclip-appview)

[![Ko-fi](https://ko-fi.com/img/githubbutton_sm.svg)](https://ko-fi.com/tijsteulings/tip)

Find it, Kip it. Save and organize bookmarks using the AT Protocol community
bookmark lexicon.

## Features

- AT Protocol OAuth authentication
- Save bookmarks to your personal data server (PDS)
- Automatic URL enrichment (title extraction)
- View and manage your bookmarks
- Reading List: filter bookmarks by a configurable tag (default: "toread")
- User settings stored in Turso database
- Uses
  [community.lexicon.bookmarks.bookmark](https://github.com/lexicon-community/lexicon/blob/main/community/lexicon/bookmarks/bookmark.json)
  schema

## Architecture

- **Frontend**: React 19 + TypeScript + Tailwind CSS
- **Backend**: Fresh 2.x on a Hetzner box (`kipclip.com`). Pull-based releases
  via signed `v*` git tags
- **AppView mirror**: every tracked user's bookmark / tag / annotation /
  preference records are mirrored from the user's PDS into a local libSQL
  database on the box, kept fresh by
  [TAP](https://github.com/bluesky-social/indigo) webhooks. Reads serve from the
  mirror; writes always go to the user's PDS via AT Protocol
- **Database**: local SQLite (`DATABASE_URL`) for all reads, sessions, and
  settings; optional Turso remote for mirror dual-write warm-standby backup
- **Bookmark storage (source of truth)**: user's PDS (not the AppView)
- **Static assets**: Bunny CDN (`cdn.kipclip.com`)
- **Edge**: Caddy on the box (TLS, security headers, CSP+SRI)

## Project Structure

```text
kipclip-appview/
├── main.ts              # Fresh app entry point (all routes)
├── dev.ts               # Development server
├── lib/                 # Backend utilities
│   ├── db.ts            # Database client
│   ├── oauth-config.ts  # OAuth configuration
│   ├── enrichment.ts    # URL metadata extraction
│   └── ...
├── frontend/
│   ├── components/      # React components
│   ├── index.html       # Entry HTML
│   ├── index.tsx        # React entry
│   └── style.css        # Custom styles
├── shared/
│   ├── types.ts         # Shared TypeScript types
│   └── utils.ts         # Shared utilities
└── tests/               # Test files
```

## Setup

### Prerequisites

- Deno installed
- Deno and a writable local filesystem (for SQLite)

### Environment Variables

```bash
COOKIE_SECRET=your-random-secret-string-at-least-32-chars  # Required
DATABASE_URL=file:/var/lib/kipclip/kipclip.db  # Optional, defaults to file:.local/kipclip.db
BASE_URL=https://kipclip.com  # Optional, derived from request if not set
# Turso mirror backup (optional, warm-standby only):
TURSO_DATABASE_URL=libsql://your-db.turso.io
TURSO_AUTH_TOKEN=your-turso-auth-token
```

The `COOKIE_SECRET` is required for encrypting OAuth session cookies.

### Local Development

```bash
# Run local dev server
deno task dev

# Type check
deno task check

# Run quality checks (format, lint)
deno task quality

# Run tests
deno task test
```

## Mascot

The kipclip mascot is Kip, a friendly chicken. Mascot images are hosted on Bunny
CDN at `cdn.kipclip.com/images/`.

## OAuth Flow

kipclip uses [@tijs/atproto-oauth](https://jsr.io/@tijs/atproto-oauth) for AT
Protocol authentication.

1. User enters their AT Protocol handle
2. App redirects to `/login?handle=user.bsky.social`
3. OAuth package handles authentication with user's PDS
4. Session stored in local SQLite (14 days)
5. User can now view/add bookmarks

For implementation details, see the
[package documentation](https://jsr.io/@tijs/atproto-oauth).

### Dependencies

- [@tijs/atproto-oauth](https://jsr.io/@tijs/atproto-oauth) - OAuth
  orchestration
- [@tijs/atproto-storage](https://jsr.io/@tijs/atproto-storage) - SQLite session
  storage with Turso adapter

## API Endpoints

### Bookmarks

- `GET /api/bookmarks` - List user's bookmarks from PDS
- `POST /api/bookmarks` - Add new bookmark with URL enrichment
- `PATCH /api/bookmarks/:rkey` - Update bookmark (tags, title, etc.)
- `DELETE /api/bookmarks/:rkey` - Delete a bookmark

### Tags

- `GET /api/tags` - List user's tags
- `POST /api/tags` - Create a new tag
- `PUT /api/tags/:rkey` - Update tag (renames across all bookmarks)
- `DELETE /api/tags/:rkey` - Delete tag (removes from all bookmarks)

### Auth

- `GET /api/auth/session` - Check current session
- `POST /api/auth/logout` - Logout
- `/login` - OAuth login flow
- `/oauth/callback` - OAuth callback

### Settings

- `GET /api/settings` - Get user settings
- `PATCH /api/settings` - Update user settings

### Sharing

- `GET /api/share/:did/:encodedTags` - Get shared bookmarks (public)
- `GET /share/:did/:encodedTags/rss` - RSS feed for shared bookmarks

## Bookmark Schema

Bookmarks are stored using the community lexicon:

```typescript
{
  subject: string;      // URL being bookmarked
  createdAt: string;    // ISO 8601 datetime
  tags?: string[];      // Optional tags
}
```

The app enriches bookmarks with page titles by fetching and parsing HTML
metadata.

## Development Guidelines

- Keep code files under 500 lines
- Write testable code with dependency injection
- Tests are in `tests/` directory
- Use TypeScript for all code

## License

MIT
