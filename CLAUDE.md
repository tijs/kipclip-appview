# Val Town Development Guide

You are an advanced assistant that helps programmers code on Val Town.

## Core Guidelines

- Ask clarifying questions when requirements are ambiguous
- Plan large refactors or big features before you start coding
- Provide complete, functional solutions rather than skeleton implementations
- Test your logic against edge cases before presenting the final solution
- Ensure all code follows Val Town's specific platform requirements
- Always prefer small, single purpose, single responsibility components over
  large files that do many things
- If a section of code is getting too complex, consider refactoring it into
  subcomponents
- **Frontend = React, Backend = Hono, Database = Drizzle** - This is the way
- **Write testable code** - Use dependency injection, follow SOLID principles,
  mock external services, write fakes instead of testing dependencies

## Code Standards

- Generate code in TypeScript or TSX
- Add appropriate TypeScript types and interfaces for all data structures
- Prefer official SDKs or libraries than writing API calls directly
- Ask the user to supply API or library documentation if you are at all unsure
  about it
- **Never bake in secrets into the code** - always use environment variables
- Include comments explaining complex logic (avoid commenting obvious
  operations)
- Follow modern ES6+ conventions and functional programming practices if
  possible
- **Every function must be testable** - Accept dependencies as parameters,
  return predictable outputs
- **Write tests alongside code** - Place `.test.ts` files next to the code they
  test

## Project Structure

### Project Organization

When organizing a Val Town project, consider separating deployable code from
local resources:

```text
├── your-project-name/       # Deployable directory (what Val Town will see)
│   ├── backend/
│   │   ├── database/
│   │   │   ├── schema.ts        # All table definitions, relations, and types
│   │   │   ├── db.ts            # Database connection and Drizzle instance  
│   │   │   ├── migrations.ts    # Schema migration logic
│   │   │   └── queries.ts       # Reusable query functions
│   │   ├── routes/              # Route modules
│   │   │   ├── [route].ts
│   │   │   └── static.ts        # Static file serving
│   │   └── index.ts             # Main entry point
│   ├── frontend/
│   │   ├── components/
│   │   │   ├── App.tsx
│   │   │   └── [Component].tsx
│   │   ├── index.html           # Minimal HTML bootstrap file
│   │   ├── index.tsx            # React entry point with createRoot
│   │   └── style.css            # Global styles (prefer Tailwind classes)
│   ├── shared/
│   │   └── utils.ts             # Shared types and functions
│   └── deno.json                # Deno configuration (MUST be in the deployed directory)
├── resources/                   # Local-only resources (images, assets)
├── docs/                        # Local-only documentation
├── README.md                    # Project documentation
└── AGENTS.md                    # AI assistant instructions
```

**Key Points:**

- Only the contents of your main project directory will be deployed to Val Town
- The `deno.json` file MUST be inside the deployment directory
- Keep non-deployable resources outside the deployment directory

### Deno Configuration

Place your `deno.json` in the deployable directory with proper structure:

```json
{
  "$schema": "https://raw.githubusercontent.com/denoland/deno/348900b8b79f4a434cab4c74b3bc8d4d2fa8ee74/cli/schemas/config-file.v1.json",
  "lock": false,
  "compilerOptions": {
    "noImplicitAny": false,
    "strict": false,
    "jsx": "react-jsx",
    "jsxImportSource": "https://esm.sh/react",
    "types": [
      "https://www.val.town/types/valtown.d.ts"
    ],
    "lib": [
      "dom",
      "dom.iterable",
      "dom.asynciterable",
      "deno.ns",
      "deno.unstable"
    ]
  },
  "lint": {
    "rules": {
      "exclude": [
        "no-explicit-any",
        "no-import-prefix"
      ]
    }
  },
  "include": [
    "backend/",
    "frontend/",
    "shared/"
  ],
  "node_modules_dir": false,
  "experimental": {
    "unstable-node-globals": true,
    "unstable-temporal": true,
    "unstable-worker-options": true,
    "unstable-sloppy-imports": true
  },
  "tasks": {
    "quality": "deno fmt && deno lint",
    "deploy": "deno task quality && vt push",
    "check": "deno check --allow-import backend/index.ts",
    "test": "deno test --allow-all tests/",
    "fmt": "deno fmt",
    "lint": "deno lint"
  }
}
```

**Key Points:**

- Use `"include"` at root level to specify which directories contain TypeScript
  files
- Don't use glob patterns in lint/check commands - they fail silently
- Type checking requires `--allow-import` flag for remote dependencies
- Keep quality checks minimal for deployment (fmt + lint)
- Separate `check` task for local type checking
- Exclude `no-import-prefix` since Val.town uses URL imports exclusively

## Frontend Architecture

**Always use React** for Val Town frontends. Here's the opinionated approach:

### Frontend Core Principles

- **HTML is just a bootstrap file** - Keep it minimal, only load React
- **No HTML fallbacks** - JavaScript is required, period
- **Single Page Application** - Let React handle all rendering
- **TypeScript everywhere** - Use `.tsx` files for all components
- **Tailwind for styling** - Use the CDN version:
  `<script src="https://cdn.twind.style" crossorigin></script>`

### React Configuration

- **Use latest versions** - Import React without version constraints
- **JSX pragma required** - Start every `.tsx` file with
  `/** @jsxImportSource https://esm.sh/react */`
- **No explicit React import needed** - With `react-jsx` transform, only import
  hooks/specific APIs
- **No build step** - Import directly from ESM URLs
- **Client-side only** - No SSR, inject initial data if needed
- **Guard browser code** - Wrap DOM access with
  `typeof document !== "undefined"` to prevent server-side execution

## Backend Architecture

### Hono Framework

- Main entry point should be `backend/index.ts`
- Export with `export default app.fetch`
- Do NOT use Hono's serveStatic middleware
- Use Val Town's `serveFile` utility for static assets
- Re-throw errors in error handler for full stack traces

### API Design

- Create RESTful routes for CRUD operations
- Use TypeScript interfaces for request/response types
- Bootstrap initial data by reading and modifying HTML
- Let errors bubble up with full context

## Database with Drizzle ORM

Val Town uses Turso (SQLite) under the hood. Use Drizzle ORM for type safety.

### Key Concepts

- **Schema-first approach** - Define all tables in `schema.ts`
- **Single database instance** - Create one connection in `db.ts`
- **Type-safe queries** - Use Drizzle's query builder
- **Migrations** - Track schema changes with versioned migrations

### Database Best Practices

- Use singular table names (e.g., `user` not `users`)
- Define relations for efficient querying
- Add indexes** on foreign keys and frequently queried columns
- Use transactions** for multi-table operations
- Handle SQLite limitations - No complex ALTER TABLE
- Limited ALTER TABLE support
- Change table names instead of altering
- Always run migrations before queries

### Common Patterns

- **Simple CRUD**: Use Drizzle's select, insert, update, delete
- **Relations**: Use `db.query` for nested data
- **Complex joins**: Use select with join methods
- **Raw SQL**: Use `db.run(sql`)`` when needed

## Testing Strategy

### Testing Core Principles

- Write tests first or ensure code is testable
- Place test files next to code: `user.ts` → `user.test.ts`
- Mock all external dependencies
- Test behavior, not implementation

### Writing Testable Code

```typescript
// BAD: Hard to test
export async function getUser(id: string) {
  const user = await db.select().from(userTable).where(eq(userTable.id, id));
  return user[0];
}

// GOOD: Testable with dependency injection
export async function getUser(id: string, dbProvider = db) {
  const user = await dbProvider.select().from(userTable).where(
    eq(userTable.id, id),
  );
  return user[0];
}
```

### SOLID Principles

1. **Single Responsibility** - Each function does one thing
2. **Open/Closed** - Use composition over modification
3. **Liskov Substitution** - Interfaces should be substitutable
4. **Interface Segregation** - Small, focused interfaces
5. **Dependency Inversion** - Depend on abstractions

### Running Tests

```bash
deno test                    # Run all tests
deno test user.test.ts      # Run specific test
deno task quality           # Includes tests in quality check
```

## TypeScript Configuration

### Type Checking

- Use `deno check` before deployment
- Add explicit types for function parameters and returns
- Define interfaces for all data structures
- External libraries from esm.sh include types automatically

### TypesSript Best Practices

- Leverage TypeScript's strict mode
- Type API responses for client-side safety
- Use type-only imports: `import type { SomeType }`
- Ignore Bun-specific errors if they appear

## Dependency Management

### Import Strategy

- **Use latest versions** - No version pinning needed
- **Import from esm.sh**: `https://esm.sh/package`
- **Trust CDN resolution** - esm.sh handles compatibility
- **Central deps file** - Use `deps.ts` for complex projects

### Common Imports

```typescript
// React (with pragma)
/** @jsxImportSource https://esm.sh/react */
import React from "https://esm.sh/react";

// Drizzle ORM
import { drizzle } from "https://esm.sh/drizzle-orm/libsql";

// Hono
import { Hono } from "https://esm.sh/hono";
```

## Development Workflow

### Task Commands

1. **During development**: `deno task check` - Catch type errors
2. **Before committing**: `deno task quality` - Format, lint, type check, test
3. **To deploy**: `deno task deploy` - Quality checks then deploy

### Deployment Process

```bash
deno task deploy  # Runs quality checks first
```

- Fix any issues before deployment succeeds
- Environment variables managed in Val Town interface
- Only deployment directory contents are uploaded

## Val Town APIs

### Triggers

1. **HTTP Trigger** - Web APIs and endpoints
2. **Cron Triggers** - Scheduled tasks (1 min minimum on pro)
3. **Email Triggers** - Process incoming emails

### Standard Libraries

- **Blob Storage**: `import { blob } from "https://esm.town/v/std/blob"`
- **SQLite**: Use Drizzle ORM instead of raw SQL
- **OpenAI**: `import { OpenAI } from "https://esm.town/v/std/openai"`
- **Email**: `import { email } from "https://esm.town/v/std/email"`

### Utility Functions

### Importing Utilities

Always import utilities with version pins to avoid breaking changes:

```ts
import {
  readFile,
  serveFile,
} from "https://esm.town/v/std/utils@85-main/index.ts";
```

### Available Utilities

**serveFile** - Serve project files with proper content types

For example, in Hono:

```ts
// serve all files in frontend/ and shared/
app.get("/frontend/*", (c) => serveFile(c.req.path, import.meta.url));
app.get("/shared/*", (c) => serveFile(c.req.path, import.meta.url));
```

**readFile** - Read files from within the project:

```ts
// Read a file from the project
const fileContent = await readFile("/frontend/index.html", import.meta.url);
```

**listFiles** - List all files in the project

```ts
const files = await listFiles(import.meta.url);
```

## Platform Specifics

### Important Limitations

- **Redirects**: Use
  `new Response(null, { status: 302, headers: { Location: "/path" }})`
- **No binary files** - Text files only
- **No Deno KV** - Use SQLite instead
- **No browser APIs** - No alert(), prompt(), confirm()
- **Automatic CORS** - Don't import CORS middleware

## Common Gotchas

### Environment

- Val Town runs on Deno, not Node.js
- Shared code can't use Deno-specific APIs
- Use esm.sh for browser/server compatibility

### Hono Issues

- NEVER import serveStatic middleware
- NEVER import CORS middleware
- Use Val Town's utilities instead
- **ALWAYS import Val Town utilities directly** - Never create placeholder
  functions for `serveFile`, `blob`, `email`, etc. Import them from
  `https://esm.town/v/std/utils/index.ts` or their respective standard library
  modules from the start

## Migration Strategy

### Principles

- Track migration history in dedicated table
- Make migrations idempotent
- Control with environment variables
- Test thoroughly before deployment

### Best Practices

- Plan schema changes carefully
- Consider performance impact
- Backup before destructive changes
- Remember SQLite limitations
- Use emojis/unicode instead of images
- Let errors bubble up with context
- Prefer APIs without keys (e.g., open-meteo for weather)
- Add error debugging script:
  `<script src="https://esm.town/v/std/catch"></script>`
- **Never create placeholder functions** for Val Town utilities - always import
  the real ones directly, even during development
