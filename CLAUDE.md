# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

kipclip is a bookmark manager for the AT Protocol ecosystem. Users authenticate via Bluesky OAuth and store bookmarks on their personal data server (PDS) using the community bookmark lexicon.

## Commands

```bash
deno task test          # Run tests
deno task check         # Type check backend and frontend
deno task quality       # Format and lint
deno task deploy        # Quality checks + deploy to Val Town
deno fmt                # Format code
deno lint               # Lint code
```

## Architecture

- **Frontend**: React SPA with Tailwind CSS, served as static files
- **Backend**: Hono HTTP server on Val Town
- **Database**: Val Town SQLite (only for OAuth sessions, not bookmarks)
- **Bookmark Storage**: User's PDS via AT Protocol

### OAuth Stack

Uses framework-agnostic OAuth libraries:
- `@tijs/atproto-oauth` - OAuth orchestration and route handlers
- `@tijs/atproto-storage` - SQLite session storage with Val Town adapter
- `@tijs/atproto-sessions` - Cookie/token management

OAuth routes are registered individually in `backend/index.ts`:
```typescript
app.get("/login", (c) => oauth.handleLogin(c.req.raw));
app.get("/oauth/callback", (c) => oauth.handleCallback(c.req.raw));
app.get("/api/auth/session", async (c) => { /* app-specific */ });
```

### Key Files

- `backend/index.ts` - Main Hono app, route registration
- `backend/oauth-config.ts` - OAuth instance configuration
- `backend/utils/session.ts` - Session extraction with error logging
- `backend/routes/` - API route handlers
- `frontend/components/App.tsx` - Main React component

## Val Town Specifics

- Export `app.fetch` as default export
- Use `serveFile` from `https://esm.town/v/std/utils` for static files
- Never use Hono's `serveStatic` or CORS middleware
- Environment variables: `BASE_URL`, `COOKIE_SECRET`

## Testing

Tests use `MemoryStorage` from `@tijs/atproto-storage` for isolation. Place test files next to source: `service.ts` → `service.test.ts`.

## Code Style

- TypeScript for all code
- JSX pragma required for React: `/** @jsxImportSource https://esm.sh/react */`
- Import from `jsr:` for Deno packages, `https://esm.sh/` for npm packages
- Keep files under 500 lines
