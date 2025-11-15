# Local Development Guide

This guide explains how to run kipclip locally for development and testing.

## Full-Stack Local Development

The local dev server provides complete full-stack development:

- ✅ **Backend API** - All endpoints work locally
- ✅ **Frontend UI** - React/TSX transpiled on-the-fly with esbuild
- ✅ **Database** - Local SQLite with migrations
- ⚠️ **OAuth Flow** - Requires public URL (see below)

### OAuth Limitations

ATProto OAuth requires a **publicly accessible** client metadata URL. For local
development:

**Option 1: Use ngrok (recommended for full OAuth testing)**

```bash
# In terminal 1: Start dev server
deno task dev

# In terminal 2: Expose with ngrok
ngrok http 8000

# Update .env with ngrok URL
BASE_URL=https://your-random-id.ngrok.io
```

**Option 2: Mock authentication (recommended for API development)**

- Use the test utilities in `backend/test-utils.ts`
- Create mock sessions for testing authenticated endpoints
- No internet required, very fast

**Option 3: Deploy to Val.Town for OAuth testing**

- Deploy changes to Val.Town
- Test OAuth flow in production
- Use local dev for API logic only

## Quick Start

1. **Copy environment template**
   ```bash
   cp .env.example .env
   ```

2. **Generate a cookie secret**
   ```bash
   openssl rand -base64 32
   ```
   Paste the output into `.env` as `COOKIE_SECRET`

3. **Start the dev server**
   ```bash
   deno task dev
   ```

4. **Open in browser**
   ```
   http://localhost:8000
   ```

## Development Setup

### Environment Configuration

Edit `.env` with your values:

```bash
# Base URL for OAuth redirects
BASE_URL=http://localhost:8000

# Secure random string (min 32 chars)
COOKIE_SECRET=your-generated-secret-from-openssl

# Optional: Custom port (default: 8000)
# PORT=3000
```

### Local vs Production

The app automatically detects whether it's running on Val.Town or locally:

- **Val.Town**: Uses Val.Town's `sqlite2` module
- **Local**: Uses Deno's native SQLite with file at `.local/kipclip.db`

No code changes needed between environments!

### Database

**Local SQLite file**: `.local/kipclip.db`

- Created automatically on first run
- Migrations run automatically
- Inspect with any SQLite browser (e.g., DB Browser for SQLite)
- Ignored by git (see `.gitignore`)

**Schema**: Defined in `backend/database/schema.ts`

**Migrations**: Tracked in `backend/database/migrations.ts`

## Testing

### Unit Tests

Fast tests using MemoryStorage and mocked OAuth:

```bash
# Run all tests
deno task test

# Watch mode for TDD
deno task test:watch
```

### Test Utilities

Use `backend/test-utils.ts` for testing:

```typescript
import { createMockSession, createTestOAuth } from "./test-utils.ts";

// Create test OAuth instance with MemoryStorage
const oauth = createTestOAuth();

// Create mock session (bypasses real authentication)
const session = createMockSession({
  sub: "did:plc:testuser",
  handle: "test.bsky.social",
});
```

### Example Tests

See `backend/routes/bookmarks.test.ts` for examples of:

- Testing route handlers
- Mocking authentication
- Validating responses

## Testing the API

Since the frontend UI requires Val.Town's transpilation, test the backend API
directly:

### Example API Requests

```bash
# Check server health
curl http://localhost:8000/

# Start OAuth login (redirects to Bluesky)
curl -I http://localhost:8000/login

# List bookmarks (requires authentication)
curl http://localhost:8000/api/bookmarks

# Get OAuth callback (after authentication)
# This happens automatically in browser flow
```

### Using with Frontend on Val.Town

1. Run backend locally: `deno task dev`
2. Deploy frontend-only changes to Val.Town
3. Point Val.Town frontend to `http://localhost:8000` API
4. Test full stack with local backend + deployed frontend

## Available Tasks

```bash
deno task dev          # Start local dev server (with watch mode)
deno task test         # Run unit tests
deno task test:watch   # Run tests in watch mode
deno task quality      # Run formatters and linters
deno task check        # Type check all files
deno task deploy       # Quality checks + deploy to Val.Town
```

## OAuth Flow

The local dev server uses **real ATProto OAuth**:

1. Click "Login with Bluesky"
2. Redirects to your PDS (e.g., bsky.social)
3. Authorize the app
4. Redirects back to `http://localhost:8000/oauth/callback`
5. Session stored in local SQLite database

## Project Structure

```
kipclip-appview/
├── .env                    # Your local environment (gitignored)
├── .env.example            # Environment template
├── .local/                 # Local dev files (gitignored)
│   └── kipclip.db         # SQLite database
├── backend/
│   ├── dev.ts             # Local dev server entry point
│   ├── index.ts           # Production entry point (Val.Town)
│   ├── test-utils.ts      # Test helpers
│   ├── database/
│   │   ├── db.ts          # Environment-aware DB config
│   │   ├── local-sqlite.ts # Local SQLite adapter
│   │   ├── schema.ts      # Database schema
│   │   └── migrations.ts  # Migration runner
│   ├── routes/
│   │   ├── bookmarks.ts   # Bookmark API routes
│   │   └── bookmarks.test.ts # Example tests
│   └── services/
│       └── auth.ts        # OAuth session handling
└── frontend/              # React frontend
```

## Troubleshooting

### Database locked error

SQLite can only have one writer at a time. Make sure you don't have multiple dev
servers running.

### OAuth redirect fails

Check that `BASE_URL` in `.env` matches the URL you're accessing (including
port).

### Port already in use

Change the port in `.env`:

```bash
PORT=3000
```

### Tests failing

Make sure you're using `deno task test` (not just `deno test`) to get the
correct permissions.

## Tips

1. **Database inspection**: Use DB Browser for SQLite to inspect
   `.local/kipclip.db`
2. **Watch mode**: Both `dev` and `test:watch` tasks auto-reload on file changes
3. **Real OAuth**: Test with your actual Bluesky account for realistic testing
4. **Fast tests**: Unit tests use MemoryStorage, so they're very fast
5. **Clean state**: Delete `.local/` directory to reset local database

## Next Steps

- Write more tests for your API routes
- Add integration tests that hit real PDS (optional)
- Inspect database schema to understand data model
- Try adding new features locally before deploying
