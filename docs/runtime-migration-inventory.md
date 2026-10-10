# Runtime-portable Hono application inventory

The source now uses Hono through `lib/http-app.ts`. This is a candidate tree: no
production cutover, DNS/service/database/TAP operations or live requests have
occurred. Existing production release remains the fallback.

## Application and middleware

`main.ts` is the shared application composition module. Install the host adapter
before importing it (`runtime/deno/install.ts` for Deno). Domain route
registrars retain standard Request/Response handlers and business logic. The
Hono binder owns matching/composition and preserves the baseline's
most-specific-path method policy, decodeURI parameter semantics/order, proxy URL
vs raw Request identity, exception unwinding and synthetic HEAD error bodies.

Effective order: proxy URL preparation; error capture; eager BASE_URL OAuth or
lazy one-shot request-derived OAuth plus preview-worker scheduling; response
security headers; OAuth/API routes; sync hook socket-peer loopback filter;
RSS/share-target; root static aliases; custom static routes; final GET SPA. The
SPA excludes /api, /oauth and /login prefixes (not just path segments).
Framework errors bypass security unwinding; explicit route failures do not.

## Startup and host boundary

Import-time libSQL connection/pragmas and cached version manifest are followed
by conditional local dotenv loading, awaited existing migrations, non-fatal
webhook GC, mirror-mode log, OAuth init and preview-worker scheduling. Test mode
skips dotenv and worker scheduling. No schema/business migration was introduced.

`runtime/host.ts` declares environment, filesystem, dotenv, telemetry and
WebSocket upgrade capabilities; shared routes/business modules have no
runtime-global or node-module imports. `runtime/deno/install.ts` implements
them. Deno-only server lifecycle is in `runtime/deno/server.ts`; imports do not
bind a socket. Start uses 127.0.0.1 by default, HOST/PORT overrides, builds a
byte/hash root-asset index, and supports owned-server stop/SIGINT/SIGTERM.
Shutdown clears preview scheduling and closes live sockets/heartbeats; an
in-flight worker tick finishes normally. Node 26.7.0 host/server/package
compatibility is verified by the shared runtime contracts; Bun 1.4.2 is locally
reported, not independently reproduced (see `runtime-portability.md`).

## Browser and build

React 19 frontend/index.tsx + frontend/index.html, AppContext/offline cache,
service worker and live-event reconnect/pong/coalescing code are unchanged. The
esbuild frontend builder remains unchanged: content-hash JS name before
source-map rewrite; SHA384 SRI over final served bytes; source map and manifest
with bundle/integrity/version/sha/builtAt. HTML caches first name/SRI; helpers
reread manifest. Custom static URLs and root asset aliases retain distinct cache
policies, ETag/conditional requests and the existing cache-bust query contract.

## Launch paths (repository templates only)

- `deno task build`: frontend build plus server type checks; no server builder.
- `deno task start` / preview: Deno runtime/server adapter with unstable-kv
  flag.
- `deno task dev`: frontend esbuild watcher plus backend watcher; static
  artifact changes restart the backend to refresh the deliberately cached HTML
  manifest.
- systemd template: Deno run runtime/deno/server.ts; HOST=127.0.0.1, PORT=8000;
  WorkingDirectory release root, existing environment file and 10s stop bound.
- Release tooling continues to call canonical build and existing health/rollback
  logic. No release/bootstrap/deploy script was executed.
- CI pins the exercised Deno 2.9.7 for format, lint, audits and tests, and a
  separate job runs the identical Deno → Bun → Node contract gates with built
  assets required.

## Route inventory

```
POST   /api/auth/logout                              routes/api/auth.ts
GET    /api/auth/session                             routes/api/auth.ts
GET    /api/bookmarks                                routes/api/bookmarks.ts
POST   /api/bookmarks/check-duplicates               routes/api/bookmarks.ts
POST   /api/bookmarks                                routes/api/bookmarks.ts
PATCH  /api/bookmarks/:rkey                          routes/api/bookmarks.ts
POST   /api/bookmarks/:rkey/enrich                   routes/api/bookmarks.ts
DELETE /api/bookmarks/:rkey                          routes/api/bookmarks.ts
POST   /api/bookmarks/bulk                           routes/api/bulk.ts
POST   /api/import                                   routes/api/import.ts
POST   /api/import/:jobId/process                    routes/api/import.ts
GET    /api/import/:jobId                            routes/api/import.ts
GET    /api/initial-data                             routes/api/initial-data.ts
GET    /api/live                                     routes/api/live.ts
GET    /api/mentions                                 routes/api/mentions.ts
POST   /api/metrics                                  routes/api/metrics.ts
POST   /api/migrate-hex-rkeys/plan                   routes/api/migrate-hex-rkeys.ts
POST   /api/migrate-hex-rkeys/batch                  routes/api/migrate-hex-rkeys.ts
GET    /api/preferences                              routes/api/preferences.ts
PUT    /api/preferences                              routes/api/preferences.ts
GET    /api/reviews                                  routes/api/reviews.ts
GET    /api/settings                                 routes/api/settings.ts
PATCH  /api/settings                                 routes/api/settings.ts
GET    /api/share/:did/:encodedTags                  routes/api/share.ts
GET    /api/stats                                    routes/api/stats.ts
GET    /api/stats/monthly                            routes/api/stats.ts
GET    /api/supporters                               routes/api/supporters.ts
USE    /api/sync/hook                                routes/api/sync.ts
GET    /api/sync/status                              routes/api/sync.ts
POST   /api/sync/hook                                routes/api/sync.ts
GET    /api/version                                  routes/api/system.ts
GET    /api/health                                   routes/api/system.ts
POST   /api/csp-report                               routes/api/system.ts
GET    /api/tags                                     routes/api/tags.ts
POST   /api/tags                                     routes/api/tags.ts
PUT    /api/tags/:rkey                               routes/api/tags.ts
GET    /api/tags/:rkey/usage                         routes/api/tags.ts
DELETE /api/tags/:rkey                               routes/api/tags.ts
POST   /api/tags/merge-duplicates                    routes/api/tags.ts
GET    /api/user/supporter-status                    routes/api/user.ts
GET    /login                                        routes/oauth.ts
GET    /oauth/callback                               routes/oauth.ts
GET    /oauth-client-metadata.json                   routes/oauth.ts
GET    /share/:did/:encodedTags/rss                  routes/share/rss.ts
POST   /share-target                                 routes/share-target.ts
GET    /opensearch.xml                               routes/static.ts
GET    /robots.txt                                   routes/static.ts
GET    /static/*                                     routes/static.ts
GET    /frontend/*                                   routes/static.ts
GET    /shared/*                                     routes/static.ts
GET    /lexicons/*                                   routes/static.ts
GET    /.well-known/atproto/lexicons/*               routes/static.ts
GET    /                                             routes/static.ts
GET    *                                             routes/static.ts
```
