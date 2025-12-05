# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with
code in this repository.

## Project Overview

kipclip is a bookmark manager for the AT Protocol ecosystem. Users authenticate
via Bluesky OAuth and store bookmarks on their personal data server (PDS) using
the community bookmark lexicon.

## Commands

```bash
deno task test          # Run tests
deno task check         # Type check backend and frontend
deno task quality       # Format and lint
deno task deploy        # Quality checks (deploy via Deno Deploy dashboard)
deno fmt                # Format code
deno lint               # Lint code
```

## Architecture

- **Frontend**: React SPA with Tailwind CSS, served as static files
- **Backend**: Fresh 2.x HTTP server on Deno Deploy
- **Database**: Turso/libSQL (only for OAuth sessions, not bookmarks)
- **Bookmark Storage**: User's PDS via AT Protocol
- **Static Assets**: Bunny CDN (`cdn.kipclip.com`)

### Fresh Framework

The app uses Fresh 2.x with programmatic routing (not file-based routes). Routes
are registered via functions that take and return the app:

```typescript
import { App } from "jsr:@fresh/core@^2.2.0";

export function registerBookmarksRoutes(app: App<any>): App<any> {
  app = app.get("/api/bookmarks", async (ctx) => {
    // ctx.req is the Request, ctx.params has route params
    return Response.json({ data });
  });
  return app;
}
```

Key differences from Hono:

- `ctx.req` instead of `c.req.raw`
- `ctx.params.id` instead of `c.req.param("id")`
- `Response.json()` instead of `c.json()`
- Export `app.handler()` instead of `app.fetch`

### OAuth Stack

Uses framework-agnostic OAuth libraries:

- `@tijs/atproto-oauth` - OAuth orchestration and route handlers
- `@tijs/atproto-storage` - SQLite session storage with Turso adapter
- `@tijs/atproto-sessions` - Cookie/token management

OAuth routes in `backend/index.ts`:

```typescript
app = app.get("/login", (ctx) => oauth.handleLogin(ctx.req));
app = app.get("/oauth/callback", (ctx) => oauth.handleCallback(ctx.req));
```

### Key Files

- `backend/index.ts` - Main Fresh app, route registration
- `backend/oauth-config.ts` - OAuth instance configuration
- `backend/utils/session.ts` - Session extraction with error logging
- `backend/routes/` - API route handlers (register function pattern)
- `frontend/components/App.tsx` - Main React component

## Deno Deploy Specifics

- Use full JSR specifiers (`jsr:@fresh/core@^2.2.0`) for consistency
- Export `app.handler()` as default export
- Static files served via esbuild-based `file-server.ts`
- Environment variables configured in Deno Deploy dashboard: `BASE_URL`,
  `COOKIE_SECRET`, `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`

## Testing

Tests use `MemoryStorage` from `@tijs/atproto-storage` for isolation. Place test
files next to source: `service.ts` → `service.test.ts`.

## Code Style

- TypeScript for all code
- JSX pragma required for React: `/** @jsxImportSource https://esm.sh/react */`
- Import from `jsr:` for Deno packages, `https://esm.sh/` for npm packages
- Keep files under 500 lines
