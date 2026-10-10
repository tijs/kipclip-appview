# Hono migration contracts and gate status

## Verified

Baseline 763 tests were frozen before porting. The Deno/Hono candidate passed
all 763, then seven HTTP-binder regressions, two framework-audit tests and one
runtime-contract execution (773 total). A local, isolated baseline copy also
passed 763. The reusable standard Request/Response harness compared both actual
apps in 35 tests: 29 synthetic cases plus full SPA/static/share bytes,
method/proxy/IP matrix, encoded params, authenticated cookie/session/API and
SQLite readbacks, production root aliases and real WebSocket adapter parity.
Temporary oracle wiring lives only in scratch, never production or final tests.

Random sealed cookies were decrypted and their data/attributes validated before
normalization. Only measured server-timing durations and validated transport
handshake randomness/clocks were additionally normalized. No unexplained parity
difference remained. Frozen synthetic response fixtures remain ordinary data.

The canonical suite passes 773/0 and exercises only the Hono app. Additional
audit regressions pin a fail-closed source-reference audit. Runtime adapter
installs are explicit in Deno tests/operational scripts; cross-runtime status is
recorded in `runtime-portability.md`.

## Contract coverage

- `migration-static`: SPA root/deep/exclusions, HEAD/OPTIONS/405,
  byte/MIME/cache, manifest/SRI/fallback/cached selection, root
  aliases/ETag/cache-bust/favicon, share escaping/count/metadata/RSS and
  upstream failure fallback.
- `migration-build`: two real offline frontend builds in disposable copy,
  deterministic bundle and final-byte SRI, source-map rewrite and old-file
  cleanup.
- `migration-oauth`: login validation/state/redirect/prompt/PWA/mobile, callback
  failure/issuer mismatch, real encrypted cookie/decode/refresh, SQLite session
  TTL, authenticated session/seen ledger and logout deletion.
- `migration-live`: actual loopback upgrade/auth 101 headers, DID fanout, 30s
  timer callback progression, pong reset/ignored malformed and binary input,
  third-tick missed-pong 1011, webhook persistence/replay/filtering and registry
  cleanup.
- `migration-boundaries`: error capture/security unwind, socket peer vs
  forwarding headers, share-target, metrics/CSP log effects, public
  hydration/cache and RSS.
- `migration-secondary-failure`: cold failure, recovery, TTL and stale
  fail-open.
- `migration-startup`: isolated denied-network lazy/eager/GC-failure processes,
  migration-before-GC, one-shot proxy-aware OAuth and worker singleton
  scheduling.
- `migration-parity`: 29 frozen status/header/body-byte observations plus
  coverage count check. Generic harness also compares explicit side effects.
- `http-app`: most-specific method choice, ordered decodeURI params, untouched
  raw Request vs normalized proxy URL, synthetic HEAD/error and middleware
  unwinding.
- Existing 659 business/API/mirror/import tests remain intact.

## Pinned baseline quirks (do not silently change)

Framework 405/uncaught 500 skip security unwinding; successful HEAD strips body
but synthetic framework-error HEAD retains it. OPTIONS uses only explicitly
declared methods. Path specificity wins before method choice, even with wildcard
SPA GET. Proxy changes public context URL only and retains existing URL port
semantics. SPA exclusion prefixes include /apiculture and /login-other.
Parameter decoding is decodeURI, not decodeURIComponent. HTML caches first
bundle/SRI. Filename hash and SRI use different pre/post-rewrite byte inputs.
Root asset aliases differ from /static cache policy. Upgrade does not propagate
cookie refresh; no implicit subprotocol selection. Two missed pings allowed,
third tick closes 1011. Some ignored record collections still broadcast;
identity/replay/failed writes do not. Malformed RSS tags become 500. Fifteen
migration declarations contain duplicate version 005, so fourteen unique
versions complete.

## Final runtime gates

Parity and zero-obsolete-reference/clean-copy gates are verified;
`audit:framework` passes without exemptions.

The cross-runtime gate passes the identical 47 contract names on Deno 2.9.7 and
Node 26.7.0, including real adapters, SQLite file persistence, encrypted
cookies, offline SDK transport, native WS/heartbeat/pong/webhook effects and
worker/owned-stop lifecycle. A fresh copied tree built frontend + portable ESM
and passed 47/0 on both WITH built-assets/SRI required, installing native
dependencies via fresh offline npm-ci rather than copying node_modules. Bun
1.4.2 passed the same contracts in a local run; independent reproduction is
outstanding. See `runtime-portability.md`.

Canonical suite: 773/0 (58 files), including a restricted child execution of
these 47 Deno contracts. Full quality passes end-to-end, alongside all audit,
typecheck/lint/clean-copy/runtime gates.

## Safety, rollback and cutover boundary

Tests use canonical test-only values, memory DB and strict mocks. Candidate
servers must bind isolated 127.0.0.1 ports. No production credentials or .env is
created in the tree. No external PDS/OAuth/Kipclip/TAP/customer requests, Kiem
writes, git writes, deployments or service controls are allowed for this
migration task.

Current production remains untouched and rollback-capable via its existing
release artifact/configuration. The repository template changes were not
applied. A live rollback, live health or deployed provenance is deliberately not
probed. Before a separately approved cutover, preserve actual deployed
release/config and rehearse candidate-to-existing rollback with isolated data
and release fixtures. Source HEAD is not proof of deployed tag. Production
cutover remains out of scope.
