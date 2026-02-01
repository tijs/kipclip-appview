# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with
code in this repository.

## Project Overview

kipclip is a bookmark manager for the AT Protocol ecosystem. Users authenticate
via Bluesky OAuth and store bookmarks on their personal data server (PDS) using
the community bookmark lexicon.

## Commands

```bash
deno task dev           # Run development server with hot reload
deno task build         # Build for production
deno task preview       # Run production server locally
deno task test          # Run all tests
deno task check         # Type check
deno task quality       # Format check and lint
deno fmt                # Format code
deno lint               # Lint code

# Run a single test by name
deno test --allow-all tests/ --filter "test name pattern"
```

## Architecture

- **Frontend**: React 19 SPA with Tailwind CSS, bundled via esbuild
- **Backend**: Fresh 2.x HTTP server on Deno Deploy
- **Database**: Turso/libSQL (only for OAuth sessions, not bookmarks)
- **Bookmark Storage**: User's PDS via AT Protocol
- **Static Assets**: Bunny CDN (`cdn.kipclip.com`)

### AT Protocol Collections

- `community.lexicon.bookmarks.bookmark` - User bookmarks (stored on user's PDS)
- `com.kipclip.tag` - User-defined tags (stored on user's PDS)

### Fresh Framework

The app uses Fresh 2.x with programmatic routing. All routes are defined in
`main.ts`:

```typescript
import { App } from "jsr:@fresh/core@^2.2.0";

let app = new App();

app = app.get("/api/bookmarks", async (ctx) => {
  // ctx.req is the Request, ctx.params has route params
  return Response.json({ data });
});

export default app.handler();
```

Key patterns:

- `ctx.req` for the Request object
- `ctx.params.rkey` for route parameters
- `Response.json()` for JSON responses
- Export `app.handler()` as default for Deno Deploy

### OAuth Stack

Uses framework-agnostic OAuth libraries from jsr:

- `@tijs/atproto-oauth` - OAuth orchestration and route handlers
- `@tijs/atproto-storage` - SQLite session storage with Turso adapter

OAuth is lazily initialized from the first request to derive BASE_URL
automatically on Deno Deploy.

## Deno Deploy

- Entry point: `main.ts`
- Environment variables: `COOKIE_SECRET` (required), `BASE_URL` (optional),
  `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`, `SENTRY_DSN`

## Testing

Tests use the app handler directly. Mock environment variables are set in
`tests/test-setup.ts`. Tests must initialize OAuth before running:

```typescript
import { app } from "../main.ts";
import { initOAuth } from "../lib/oauth-config.ts";

initOAuth("https://kipclip.com");
const handler = app.handler();
```

## Local Development with ngrok

To test OAuth flows locally (e.g., on a mobile device), you need ngrok to expose
the local server with a public HTTPS URL. OAuth requires the BASE_URL to match
the public URL.

### Setup Steps

1. **Start ngrok first** to get the public URL:

   ```bash
   ngrok http 8000
   ```

2. **Copy the ngrok URL** from the terminal (e.g.,
   `https://abc123.ngrok-free.app`)

3. **Start the dev server** with environment variables:

   ```bash
   COOKIE_SECRET="local-dev-cookie-secret-32-characters-min" \
   BASE_URL="https://abc123.ngrok-free.app" \
   deno task dev
   ```

4. **Access the app** via the ngrok URL (not localhost)

### Why This Is Needed

- Bluesky OAuth rejects `localhost` in redirect URIs (per RFC 8252)
- The server derives its OAuth client ID and redirect URIs from BASE_URL
- Without BASE_URL set, it defaults to the request host which may cause
  mismatches

### Quick One-Liner

Start ngrok, get URL, then run:

```bash
# In terminal 1
ngrok http 8000

# In terminal 2 (replace URL with your ngrok URL)
COOKIE_SECRET="local-dev-cookie-secret-32-characters-min" \
BASE_URL="https://YOUR-NGROK-URL.ngrok-free.app" \
deno task dev
```

## Code Style

- TypeScript for all code
- JSX configured in `deno.json` (no pragma needed in files)
- Import from `jsr:` for Deno packages, `https://esm.sh/` for npm packages
- Keep files under 500 lines
