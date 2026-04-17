/**
 * Unit tests for atprotofans.com supporter detection.
 */

import "./test-setup.ts";

import { assertEquals } from "@std/assert";
import {
  _clearSupporterCache,
  AUTO_SUPPORTER_DIDS,
  isUserSupporter,
  KIPCLIP_DID,
} from "../lib/atprotofans.ts";
import {
  createMockSession,
  createPdsResponse,
  listRecordsResponse,
} from "./test-helpers.ts";

const NON_ALLOWLISTED_DID = "did:plc:usertest456";

function supporterRecords(subject: string) {
  return listRecordsResponse([
    {
      uri: `at://${NON_ALLOWLISTED_DID}/com.atprotofans.supporter/abc`,
      cid: "bafytest",
      value: { subject, txnid: "01HXYZ", signatures: [] },
    },
  ]);
}

Deno.test("isUserSupporter — hardcoded allowlist short-circuits true", async () => {
  _clearSupporterCache();
  let called = false;
  const session = createMockSession({
    did: KIPCLIP_DID, // In AUTO_SUPPORTER_DIDS
  });
  // Override makeRequest to detect accidental PDS calls
  const wrapped = {
    ...session,
    makeRequest: () => {
      called = true;
      return Promise.resolve(listRecordsResponse([]));
    },
  };

  const result = await isUserSupporter(wrapped as typeof session);
  assertEquals(result, true);
  assertEquals(called, false, "allowlist should skip PDS lookup");
  // Sanity: both allowlisted DIDs are recognised
  assertEquals(AUTO_SUPPORTER_DIDS.has(KIPCLIP_DID), true);
});

Deno.test("isUserSupporter — injected autoSupporterDids short-circuits true", async () => {
  _clearSupporterCache();
  let called = false;
  const injectedDid = "did:plc:injected-for-test";
  const session = createMockSession({ did: injectedDid });
  const wrapped = {
    ...session,
    makeRequest: () => {
      called = true;
      return Promise.resolve(listRecordsResponse([]));
    },
  };

  const result = await isUserSupporter(wrapped as typeof session, {
    autoSupporterDids: new Set([injectedDid]),
  });
  assertEquals(result, true);
  assertEquals(called, false, "injected allowlist should skip PDS lookup");
});

Deno.test("isUserSupporter — empty records returns false", async () => {
  _clearSupporterCache();
  const session = createMockSession({
    did: NON_ALLOWLISTED_DID,
    pdsResponses: new Map([
      ["com.atprotofans.supporter", listRecordsResponse([])],
    ]),
  });

  const result = await isUserSupporter(session);
  assertEquals(result, false);
});

Deno.test("isUserSupporter — matching record returns true", async () => {
  _clearSupporterCache();
  const session = createMockSession({
    did: NON_ALLOWLISTED_DID,
    pdsResponses: new Map([
      ["com.atprotofans.supporter", supporterRecords(KIPCLIP_DID)],
    ]),
  });

  const result = await isUserSupporter(session);
  assertEquals(result, true);
});

Deno.test("isUserSupporter — record pointing at another creator returns false", async () => {
  _clearSupporterCache();
  const session = createMockSession({
    did: NON_ALLOWLISTED_DID,
    pdsResponses: new Map([
      [
        "com.atprotofans.supporter",
        supporterRecords("did:plc:some-other-creator"),
      ],
    ]),
  });

  const result = await isUserSupporter(session);
  assertEquals(result, false);
});

Deno.test("isUserSupporter — PDS error is negative-cached briefly", async () => {
  _clearSupporterCache();
  let callCount = 0;
  const session = createMockSession({ did: NON_ALLOWLISTED_DID });
  const wrapped = {
    ...session,
    makeRequest: (_method: string, _url: string) => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve(
          new Response("service unavailable", { status: 503 }),
        );
      }
      return Promise.resolve(supporterRecords(KIPCLIP_DID));
    },
  };

  const first = await isUserSupporter(wrapped as typeof session);
  assertEquals(first, false);
  assertEquals(callCount, 1);

  // Second call within negative-cache window returns cached false
  const cached = await isUserSupporter(wrapped as typeof session);
  assertEquals(cached, false);
  assertEquals(callCount, 1, "failure is negative-cached (protects PDS)");

  // Simulate negative-cache TTL expiry by clearing cache; retry recovers.
  _clearSupporterCache();
  const recovered = await isUserSupporter(wrapped as typeof session);
  assertEquals(recovered, true);
  assertEquals(callCount, 2);
});

Deno.test("isUserSupporter — cached result is reused within TTL", async () => {
  _clearSupporterCache();
  let callCount = 0;
  const session = createMockSession({ did: NON_ALLOWLISTED_DID });
  const wrapped = {
    ...session,
    makeRequest: () => {
      callCount++;
      return Promise.resolve(listRecordsResponse([]));
    },
  };

  await isUserSupporter(wrapped as typeof session);
  await isUserSupporter(wrapped as typeof session);
  await isUserSupporter(wrapped as typeof session);

  assertEquals(callCount, 1, "subsequent calls should hit cache");
});

Deno.test("isUserSupporter — bypassCache honors refresh cooldown", async () => {
  _clearSupporterCache();
  let callCount = 0;
  const session = createMockSession({ did: NON_ALLOWLISTED_DID });
  const wrapped = {
    ...session,
    makeRequest: () => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve(listRecordsResponse([]));
      }
      return Promise.resolve(supporterRecords(KIPCLIP_DID));
    },
  };

  const first = await isUserSupporter(wrapped as typeof session);
  assertEquals(first, false);
  assertEquals(callCount, 1);

  // Immediate bypassCache call: cooldown prevents hammering the PDS.
  const inCooldown = await isUserSupporter(wrapped as typeof session, {
    bypassCache: true,
  });
  assertEquals(inCooldown, false, "cooldown serves cached value");
  assertEquals(callCount, 1, "cooldown blocks re-query");

  // After cache clear (simulating cooldown expired), bypassCache re-queries.
  _clearSupporterCache();
  const refreshed = await isUserSupporter(wrapped as typeof session, {
    bypassCache: true,
  });
  assertEquals(refreshed, true);
  assertEquals(callCount, 2);
});

Deno.test("isUserSupporter — paginates through cursor", async () => {
  _clearSupporterCache();
  let call = 0;
  const session = createMockSession({ did: NON_ALLOWLISTED_DID });
  const wrapped = {
    ...session,
    makeRequest: () => {
      call++;
      if (call === 1) {
        // First page: unrelated records + cursor
        return Promise.resolve(
          createPdsResponse({
            records: [
              {
                uri: "at://x/com.atprotofans.supporter/1",
                cid: "c",
                value: { subject: "did:plc:other" },
              },
            ],
            cursor: "next",
          }),
        );
      }
      // Second page: the kipclip supporter record
      return Promise.resolve(supporterRecords(KIPCLIP_DID));
    },
  };

  const result = await isUserSupporter(wrapped as typeof session);
  assertEquals(result, true);
  assertEquals(call, 2);
});

Deno.test("isUserSupporter — caps pagination at MAX_PAGES", async () => {
  _clearSupporterCache();
  let callCount = 0;
  const session = createMockSession({ did: NON_ALLOWLISTED_DID });
  // Malicious PDS: always returns a cursor, never the matching record.
  const wrapped = {
    ...session,
    makeRequest: () => {
      callCount++;
      return Promise.resolve(
        createPdsResponse({
          records: [
            {
              uri: `at://x/com.atprotofans.supporter/${callCount}`,
              cid: "c",
              value: { subject: "did:plc:someone-else" },
            },
          ],
          cursor: `cursor-${callCount}`,
        }),
      );
    },
  };

  const result = await isUserSupporter(wrapped as typeof session);
  assertEquals(result, false);
  assertEquals(callCount, 3, "pagination must stop at MAX_PAGES=3");
});
