# Runtime adapters and verified portability

## Actual matrix (macOS aarch64)

The same `tests/runtime/contracts.mjs` suite passed 47/0 under Deno 2.9.7 and
Node 26.7.0. Its test-name lists are identical. A clean copied tree, initially
without native dependencies, generated server cache, portable bundle, frontend
bundle or manifest, also built and passed 47/0 on both with built assets
REQUIRED (including actual served SHA384/SRI/cache equality). Bun 1.4.2 passed
the same contracts in a local run; independent reproduction is outstanding.

This is application/adapter compatibility on these versions/platform, not a
claim about every OS/runtime version, real remote OAuth/PDS protocol, or live
deployment. The existing full business suite remains a Deno suite. Cross-runtime
contracts exercise actual shared routes, encrypted cookies, SQLite effects and
native wire adapters; provider transport is strictly mocked and unexpected
external requests fail. No production cutover occurred.

## Build and start

Deno 2.9.7 is the build tool; Node/Bun do NOT need Deno for native application
startup after build. The portable artifact is standard ESM. Exact JSR/npm
versions are resolved from deno.lock; package-lock.json pins native host
dependencies.

```
deno task build                 # frontend + Deno/shared server typecheck
deno task build:portable        # JSR/.ts/pure npm graph → dist/application.mjs
deno task build:all             # both builds
npm ci --ignore-scripts         # explicit prebuilt native host dependencies
HOST=127.0.0.1 PORT=8787 npm run start:node
HOST=127.0.0.1 PORT=8788 npm run start:bun
```

Run native starts only with isolated test data/values during this migration.
Never use live credentials, databases or service configuration. Bun can be
invoked by absolute path instead of putting it on PATH. Default host is
127.0.0.1; adapters do not listen when imported. Deno retains `--unstable-kv`
through canonical tasks.

`deno bundle` is experimental in 2.9.7 and uses its bundled compiler; build
tooling is version-pinned in CI. Application code is not vendored or rewritten.
Native DB and telemetry stay outside the browser-target ESM bundle behind the
host boundary. No caches or host dependency folders are committed. The frontend
builder and React/shared browser source remain unchanged.

## Adapter contracts

`runtime/host.ts` declares env access, root URL, byte/text filesystem, local
dotenv, process/runtime version, SQLite-client factory, telemetry and WebSocket
upgrade. Shared route/business implementations do not import native modules or
runtime globals; `deno task audit:runtime` enforces that boundary.

- Deno: native env/fs/process, local libSQL factory, Deno Sentry SDK, official
  Hono Deno WebSocket helper; native 101 Response lets shared middleware add
  headers.
- Node: standard native Web APIs, Hono node-server 1.19.17 (global-object
  override OFF), libSQL/native N-API, Sentry node 10.76.2, ws 8.21.0. Raw
  upgrades run shared authentication and response/security composition BEFORE
  native handshake.
- Bun: env/native file APIs via its node-compatible filesystem, libSQL/ native
  N-API, Sentry bun 10.76.2, Bun.serve/native WebSocket. Upgrade also defers
  until all shared response headers are available.

Bun's observable implicit Response MIME defaults differ from Deno (deferred
until send); a host-only native-Response Proxy supplies the baseline defaults,
while preserving native prototypes/instanceof/redirect/error and ResponseInit
getter semantics. There is no Deno-global emulation or application-level runtime
branch. Node's Hono global-object optimization is disabled because its implicit
MIME formatting otherwise differs from baseline.

Start returns owned origin/server/stop and core capability handle. Stop is
idempotent, unregisters owned signal listeners, clears worker scheduling, closes
owned live sockets/heartbeats and stops listening. Already-running preview ticks
finish normally (not cancellation/drain guarantees). Signal handlers apply only
to the process started by that adapter. No production process was controlled.

## WebSocket and data gates

Native 101/security headers, failed-auth 401, no cookie refresh, no implicit
subprotocol selection, DID fanout, binary/malformed-frame ignoring, pong reset,
third-tick 1011 close and cleanup are exercised on ACTUAL transports. Webhook →
SQLite → WS persistence, replay and identity/unknown filtering match baseline;
ignored collections' existing broadcast behavior is deliberately preserved.

SQLite migration count 14, real memory DB effects, and a temporary file DB
close/reopen roundtrip pass on all three adapters, with Bun locally reported
only. Real WebCrypto encrypted SID cookies, callback storage TTL/session
refresh/logout deletion pass. Remote OAuth methods are mocked at their client
boundary, not replaced by fabricated cookie/storage responses. Sentry SDKs send
one event through a custom in-memory transport; no Sentry/customer endpoint is
contacted. New native SDKs were upgraded to patched 10.76.2 after detecting OTel
advisories; Deno SDK remains 10.34.0.

## Reproduce contracts and quality

```
TMPDIR=<isolated-scratch> deno task test:runtime:deno
TMPDIR=<isolated-scratch> deno task test:runtime:bun
TMPDIR=<isolated-scratch> deno task test:runtime:node
KIPCLIP_REQUIRE_BUILT_ASSETS=1 TMPDIR=<isolated-scratch> deno task test:runtime:node
deno task test
deno task audit:framework
deno task audit:runtime
deno task audit:native
deno task quality
```

Canonical `test` includes a restricted child invocation of the same 47 Deno
contracts; Node/Bun use the explicit runtime tasks. All env in that suite is
synthetic; no .env load. It never follows mock OAuth redirects to remote hosts.
The extra SRI check is REQUIRED on clean-built copies; source-only contracts can
run before frontend build, with the absence explicitly distinguished.

## Rollback and production boundary

Existing Deno production release/configuration remains untouched and the
rollback fallback. Native portability is not permission to switch
services/runtimes. Before an explicitly approved cutover, preserve actual
deployed artifact/config/version, rehearse candidate-to-existing release
rollback with isolated data, and approve separate DNS/Caddy/systemd/TAP/data
work. Live health/provenance/cutover/rollback were deliberately not probed or
executed during this migration.
