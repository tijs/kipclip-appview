# kipclip

[![Test](https://github.com/tijs/kipclip-appview/workflows/Test/badge.svg)](https://github.com/tijs/kipclip-appview/actions/workflows/test.yml)

[![Ko-fi](https://ko-fi.com/img/githubbutton_sm.svg)](https://ko-fi.com/tijsteulings/tip)

Find it, Kip it. Save and organize bookmarks using the AT Protocol community
bookmark lexicon.

## Features

- AT Protocol OAuth authentication
- Save bookmarks to your personal data server (PDS)
- Automatic URL enrichment (title extraction)
- View and manage your bookmarks
- Uses
  [community.lexicon.bookmarks.bookmark](https://github.com/lexicon-community/lexicon/blob/main/community/lexicon/bookmarks/bookmark.json)
  schema

## Architecture

- **Frontend**: React + TypeScript + Tailwind CSS
- **Backend**: Fresh 2.x + AT Protocol OAuth on Deno Deploy
- **Database**: Turso/libSQL for OAuth session storage
- **Bookmark Storage**: User's PDS (not in appview database)
- **Static Assets**: Bunny CDN (`cdn.kipclip.com`)

## Project Structure

```text
kipclip-appview/
├── backend/
│   ├── database/          # SQLite migrations
│   ├── routes/            # API & static routes
│   ├── services/          # URL enrichment
│   └── index.ts           # Main Fresh app
├── frontend/
│   ├── components/        # React components
│   ├── index.html         # Bootstrap
│   ├── index.tsx          # React entry
│   └── style.css          # Custom styles
└── shared/
    └── types.ts           # Shared TypeScript types
```

## Setup

### Prerequisites

- Deno installed
- Deno Deploy account
- Turso database

### Environment Variables

Configure these in the Deno Deploy dashboard:

```bash
BASE_URL=https://kipclip.com
COOKIE_SECRET=your-random-secret-string-at-least-32-chars
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
4. Session stored in Turso database (14 days)
5. User can now view/add bookmarks

For implementation details, see the
[package documentation](https://jsr.io/@tijs/atproto-oauth).

### Dependencies

- [@tijs/atproto-oauth](https://jsr.io/@tijs/atproto-oauth) - OAuth
  orchestration
- [@tijs/atproto-storage](https://jsr.io/@tijs/atproto-storage) - SQLite session
  storage
- [@tijs/atproto-sessions](https://jsr.io/@tijs/atproto-sessions) - Cookie/token
  management

## API Endpoints

- `GET /api/bookmarks` - List user's bookmarks from PDS
- `POST /api/bookmarks` - Add new bookmark with URL enrichment
- `DELETE /api/bookmarks/:rkey` - Delete a bookmark
- `/api/auth/session` - Check current session
- `/api/auth/logout` - Logout
- `/login` - OAuth login flow
- `/oauth/callback` - OAuth callback

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
- Test files go next to code: `service.ts` → `service.test.ts`
- Follow SOLID principles
- Use TypeScript for all code

## License

MIT
