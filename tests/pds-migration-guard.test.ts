/**
 * Tests for lib/pds-migration-guard.ts — write-side migration detection.
 *
 * Pins:
 *   - Same PDS host (no migration) → migrated:false.
 *   - Different PDS host (user moved repos) → migrated:true + currentPdsUrl.
 *   - Resolve failure (PLC down / DID gone) → fail-open migrated:false, so a
 *     PLC blip never logs users out.
 *   - Confirmed matches are cached — a second check skips the PLC fetch — and
 *     a changed session host bypasses the cache and re-resolves.
 *   - Unparseable session URL → fail-open.
 */

import "./test-setup.ts";
import { assertEquals } from "@std/assert";

import {
  _resetPdsMigrationCache,
  checkPdsMigration,
  evaluatePdsMigration,
} from "../lib/pds-migration-guard.ts";

const DID = "did:plc:guardtest";

function didDocJson(pdsUrl: string): string {
  return JSON.stringify({
    service: [
      {
        id: "#atproto_pds",
        type: "AtprotoPersonalDataServer",
        serviceEndpoint: pdsUrl,
      },
    ],
    alsoKnownAs: ["at://handle.test"],
  });
}

/** Stub global fetch (resolveDid → plc.directory). `responder` maps the
 * requested URL to a Response; `calls` counts invocations. */
function stubFetch(
  responder: (url: string) => Response,
): { calls: () => number; restore: () => void } {
  let n = 0;
  const original = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request) => {
    n++;
    return Promise.resolve(responder(String(input)));
  }) as typeof globalThis.fetch;
  return {
    calls: () => n,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

Deno.test("same PDS host → not migrated", async () => {
  _resetPdsMigrationCache();
  const stub = stubFetch(() =>
    new Response(didDocJson("https://pds.example.com"), { status: 200 })
  );
  try {
    const res = await checkPdsMigration(DID, "https://pds.example.com");
    assertEquals(res.migrated, false);
  } finally {
    stub.restore();
  }
});

Deno.test("different PDS host → migrated, surfaces current PDS", async () => {
  _resetPdsMigrationCache();
  // Session bound to the old host; DID doc now points at the new host.
  const stub = stubFetch(() =>
    new Response(didDocJson("https://caramelo.social.br"), { status: 200 })
  );
  try {
    const res = await checkPdsMigration(
      DID,
      "https://porcini.us-east.host.bsky.network",
    );
    assertEquals(res.migrated, true);
    assertEquals(res.currentPdsUrl, "https://caramelo.social.br");
  } finally {
    stub.restore();
  }
});

Deno.test("ignores explicit default port and trailing slash — no false-positive logout", async () => {
  _resetPdsMigrationCache();
  // DID doc publishes an explicit :443; session URL has none + a trailing slash.
  // Same hostname → must NOT be treated as a migration.
  const stub = stubFetch(() =>
    new Response(didDocJson("https://pds.example.com:443"), { status: 200 })
  );
  try {
    const res = await checkPdsMigration(DID, "https://pds.example.com/");
    assertEquals(res.migrated, false);
  } finally {
    stub.restore();
  }
});

Deno.test("resolve failure → fail-open (not migrated)", async () => {
  _resetPdsMigrationCache();
  const stub = stubFetch(() => new Response("nope", { status: 500 }));
  try {
    const res = await checkPdsMigration(DID, "https://pds.example.com");
    assertEquals(res.migrated, false);
  } finally {
    stub.restore();
  }
});

Deno.test("confirmed match is cached — second check skips PLC", async () => {
  _resetPdsMigrationCache();
  const stub = stubFetch(() =>
    new Response(didDocJson("https://pds.example.com"), { status: 200 })
  );
  try {
    await checkPdsMigration(DID, "https://pds.example.com");
    await checkPdsMigration(DID, "https://pds.example.com");
    assertEquals(stub.calls(), 1); // only the first resolved via PLC
  } finally {
    stub.restore();
  }
});

Deno.test("changed session host bypasses cache and re-resolves", async () => {
  _resetPdsMigrationCache();
  // DID doc always resolves to a.example.com.
  const stub = stubFetch(() =>
    new Response(didDocJson("https://a.example.com"), { status: 200 })
  );
  try {
    await checkPdsMigration(DID, "https://a.example.com"); // match → cached
    const before = stub.calls();
    const res = await checkPdsMigration(DID, "https://b.example.com"); // host changed
    assertEquals(res.migrated, true); // current a.example.com != session b
    assertEquals(stub.calls() > before, true); // re-resolved, cache bypassed
  } finally {
    stub.restore();
  }
});

Deno.test("unparseable session URL → fail-open", async () => {
  _resetPdsMigrationCache();
  const stub = stubFetch(() =>
    new Response(didDocJson("https://pds.example.com"), { status: 200 })
  );
  try {
    const res = await checkPdsMigration(DID, "not-a-url");
    assertEquals(res.migrated, false);
    assertEquals(stub.calls(), 0); // bailed before resolving
  } finally {
    stub.restore();
  }
});

// evaluatePdsMigration — the session-path decision (wiring that lib/session.ts
// consumes). Covers the GET-exempt and mutating-blocked behavior end to end.

Deno.test("evaluate: GET is exempt — no PLC call, no block, no refresh", async () => {
  _resetPdsMigrationCache();
  const stub = stubFetch(() =>
    new Response(didDocJson("https://new.example.com"), { status: 200 })
  );
  try {
    const d = await evaluatePdsMigration("GET", DID, "https://old.example.com");
    assertEquals(d.block, undefined); // reads never blocked, even when migrated
    assertEquals(d.refreshPdsUrl, null); // no fresh value persisted on reads
    assertEquals(stub.calls(), 0); // read hot path stays PLC-free
  } finally {
    stub.restore();
  }
});

Deno.test("evaluate: mutating + migrated → block + authoritative refresh host", async () => {
  _resetPdsMigrationCache();
  const stub = stubFetch(() =>
    new Response(didDocJson("https://caramelo.social.br"), { status: 200 })
  );
  try {
    const d = await evaluatePdsMigration(
      "POST",
      DID,
      "https://porcini.us-east.host.bsky.network",
    );
    assertEquals(d.block?.type, "PDS_MIGRATED");
    // tracked_dids must get the CURRENT host, never the stale session one.
    assertEquals(d.refreshPdsUrl, "https://caramelo.social.br");
    assertEquals(d.currentPdsUrl, "https://caramelo.social.br");
  } finally {
    stub.restore();
  }
});

Deno.test("evaluate: mutating + not migrated → no block, refresh from session", async () => {
  _resetPdsMigrationCache();
  const stub = stubFetch(() =>
    new Response(didDocJson("https://pds.example.com"), { status: 200 })
  );
  try {
    const d = await evaluatePdsMigration(
      "DELETE",
      DID,
      "https://pds.example.com",
    );
    assertEquals(d.block, undefined);
    assertEquals(d.refreshPdsUrl, "https://pds.example.com");
  } finally {
    stub.restore();
  }
});
