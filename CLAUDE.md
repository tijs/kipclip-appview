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
deno task test          # Run tests
deno task check         # Type check
deno task quality       # Format check and lint
deno fmt                # Format code
deno lint               # Lint code
```

## Architecture

- **Frontend**: React SPA with Tailwind CSS, served as static files
- **Backend**: Fresh 2.x HTTP server on Deno Deploy
- **Database**: Turso/libSQL (only for OAuth sessions, not bookmarks)
- **Bookmark Storage**: User's PDS via AT Protocol
- **Static Assets**: Bunny CDN (`cdn.kipclip.com`)

### Project Structure

```
kipclip-appview/
├── main.ts              # Main Fresh app entry point (all routes)
├── dev.ts               # Development server with hot reload
├── lib/                 # Shared utilities
│   ├── db.ts           # Database client (Turso/libSQL)
│   ├── migrations.ts   # Database migrations
│   ├── oauth-config.ts # OAuth instance configuration
│   ├── session.ts      # Session extraction with error logging
│   ├── sentry.ts       # Error tracking
│   ├── enrichment.ts   # URL metadata extraction
│   └── file-server.ts  # Static file serving with TS transpilation
├── frontend/            # React SPA
│   ├── index.html      # Entry HTML
│   ├── index.tsx       # React entry point
│   ├── style.css       # Styles
│   └── components/     # React components
├── shared/              # Shared types and utilities
│   ├── types.ts        # TypeScript types
│   └── utils.ts        # Shared utilities
└── tests/               # Test files
    ├── test-setup.ts   # Test environment setup
    └── api.test.ts     # API tests
```

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
- `ctx.params.id` for route parameters
- `Response.json()` for JSON responses
- Export `app.handler()` as default for Deno Deploy

### OAuth Stack

Uses framework-agnostic OAuth libraries:

- `@tijs/atproto-oauth` - OAuth orchestration and route handlers
- `@tijs/atproto-storage` - SQLite session storage with Turso adapter
- `@tijs/atproto-sessions` - Cookie/token management

OAuth routes:

```typescript
app = app.get("/login", (ctx) => oauth.handleLogin(ctx.req));
app = app.get("/oauth/callback", (ctx) => oauth.handleCallback(ctx.req));
```

## Deno Deploy

- Entry point: `main.ts`
- Exports `app.handler()` as default
- Environment variables: `BASE_URL`, `COOKIE_SECRET`, `TURSO_DATABASE_URL`,
  `TURSO_AUTH_TOKEN`, `SENTRY_DSN`

## Testing

Tests are in the `tests/` directory. The test database uses a mock client to
avoid actual connections.

```bash
deno task test
```

## Code Style

- TypeScript for all code
- JSX pragma required for React: `/** @jsxImportSource https://esm.sh/react */`
- Import from `jsr:` for Deno packages, `https://esm.sh/` for npm packages
- Keep files under 500 lines
