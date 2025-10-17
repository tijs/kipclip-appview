# kipclip

Bookmark your web with a friendly chicken. Save and organize bookmarks using the
AT Protocol community bookmark lexicon.

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
- **Backend**: Hono + AT Protocol OAuth
- **Database**: Val.town SQLite for OAuth session storage
- **Bookmark Storage**: User's PDS (not in appview database)

## Project Structure

```
kipclip-appview/
├── backend/
│   ├── database/          # Drizzle schema & migrations
│   ├── routes/            # API & static routes
│   ├── services/          # URL enrichment
│   └── index.ts           # Main Hono app
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
- Val Town account

### Environment Variables

Create these in your Val.town environment:

```bash
BASE_URL=https://your-val.val.town
COOKIE_SECRET=your-random-secret-string-at-least-32-chars
```

Val.town provides SQLite automatically. The `COOKIE_SECRET` is required for
encrypting OAuth session cookies.

### Local Development

```bash
# Type check
deno task check

# Run quality checks (format, lint, type check, test)
deno task quality

# Deploy to Val.town
deno task deploy
```

## Mascot

The kipclip mascot is a friendly chicken carrying a bookmark bag. Replace the
placeholder image URL in `frontend/components/Login.tsx` with your
Cloudinary-hosted mascot image.

## OAuth Flow

1. User enters their AT Protocol handle
2. App redirects to `/login?handle=user.bsky.social`
3. OAuth package handles authentication with user's PDS
4. Session stored in Val.town SQLite (30 days)
5. User can now view/add bookmarks

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
