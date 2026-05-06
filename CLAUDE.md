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
deno task check         # Type-check the server entrypoint (main.ts)
deno task check:frontend # Targeted frontend check (TS2304 / TS2307 fatal — catches missing imports / undefined components like the EditTag <Button> regression)
deno task quality       # fmt --check + lint + audit + check + check:frontend (run before pushing to main)
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
- Auto-deploys on push to `main` via Deno Deploy's GitHub integration
- The GitHub test workflow (format, lint, tests) does NOT gate deployment —
  always run `deno task quality && deno task test` before pushing to main
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

## Releases

The project uses semantic versioning (currently pre-1.0). Versions are tracked
in `CHANGELOG.md` and as annotated git tags. The Hetzner production box pulls
the latest `v*` tag merged into `main` on a 60s systemd timer and atomic-swaps
to it (see `deploy/release/README.md`).

To cut a new release from any machine with push perms:

1. Update `CHANGELOG.md` — rename `[Unreleased]` to `[vX.Y.Z] - YYYY-MM-DD` and
   add a fresh `[Unreleased]` section above
2. Commit the changelog update
3. Tag the commit: `git tag -a vX.Y.Z -m "vX.Y.Z - Short description"`
4. Push with tags: `git push origin main --tags`

Within ~60s, the box swaps to the new tag. Verify with
`curl https://kipclip.com/api/version`. The frontend Footer shows the running
tag and links to the GitHub release page.

Pin override / rollback / failure recovery: see `deploy/release/README.md`.

Guidelines:

- Follow [Keep a Changelog](https://keepachangelog.com) format
- Bump minor version (0.x.0) for new features or significant changes
- Bump patch version (0.x.y) for bug fixes
- Keep descriptions concise and user-facing (what changed, not how)

## Code Style

- TypeScript for all code
- JSX configured in `deno.json` (no pragma needed in files)
- Import from `jsr:` for Deno packages, `https://esm.sh/` for npm packages
- Keep files under 500 lines

## Documented Solutions

`docs/solutions/` — documented solutions to past problems (bugs, best practices,
workflow patterns), organized by category subdirectory (e.g.
`performance-issues/`, `integration-issues/`) with YAML frontmatter fields like
`module`, `tags`, `problem_type`, `component`. Relevant when implementing or
debugging in documented areas — grep frontmatter to find applicable prior
learnings before re-investigating.

## Design Context

### Users

Bluesky / AT Protocol users who want a simple, reliable bookmark manager. They
value data ownership. Context: saving links throughout the day from desktop and
mobile, returning later to find or read them.

### Brand Personality

**Friendly, simple, trustworthy.** Feels like a well-made everyday tool. Kip the
chicken adds character without making the app feel like a toy.

### Aesthetic Direction

**North star: Things 3 / Bear.** Apple-quality polish, subtle details, beautiful
typography. Premium but never complex. Design disappears into the content.

- Palette: Coral `#e66456`, Cream `#f5f1e8`, Teal `#5b8a8f`, Orange `#f4a261`
- Theme: Light (warm cream background is signature)
- Anti-references: generic SaaS, social media feeds, dev tools, overly cute

### Color Roles

Each color has one job. Reaching for coral everywhere makes the app feel
oppressive — roles keep the palette doing work.

- **Coral** — primary CTAs only: "Add Bookmark", "Create Tag", "Share
  collection", "Support on atprotofans", destructive-confirm. One coral element
  per region; if two compete, demote one.
- **Teal** — selected / active state: selected tag chips (sidebar, filter bar,
  bulk-tag modal), supporter status pill, `.btn-secondary`. Reads as "status,"
  not "action."
- **Orange** — celebration / reward moments: the illustrated supporter badge on
  the Settings → Supporter tab. Use sparingly; orange loses its meaning if it's
  everywhere.
- **Cream** — background only. Never a button or pill fill.
- **Grays** — chrome, borders, body copy, disabled states.

Quick sanity check before shipping a UI change: if coral appears in more than
~2–3 places in a single view, something that should be teal or gray is wearing
coral.

### Design Principles

1. **Content is king.** Bookmarks and tags are the star. UI chrome recedes.
2. **Quiet confidence.** Polish shows in spacing, typography, transitions — not
   decorative effects.
3. **Warm, not cute.** Coral-and-cream palette gives soul without crossing into
   playful.
4. **Respect the user's time.** Fast interactions, clear hierarchy, no clutter.
5. **Accessible by default.** WCAG AA. Good contrast, keyboard nav, screen
   reader support.
