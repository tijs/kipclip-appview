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

Deno.test("isUserSupporter — PDS error returns false and is not cached", async () => {
  _clearSupporterCache();
  let callCount = 0;
  const session = createMockSession({ did: NON_ALLOWLISTED_DID });
  const wrapped = {
    ...session,
    makeRequest: (_method: string, _url: string) => {
      callCount++;
      // First call: 503. Second call: success with supporter record.
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

  // Second call should re-query (not cached) and return true
  const second = await isUserSupporter(wrapped as typeof session);
  assertEquals(second, true);
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

Deno.test("isUserSupporter — bypassCache forces a re-query", async () => {
  _clearSupporterCache();
  let callCount = 0;
  const session = createMockSession({ did: NON_ALLOWLISTED_DID });
  const wrapped = {
    ...session,
    makeRequest: () => {
      callCount++;
      // First call: not a supporter. Second call: is a supporter.
      if (callCount === 1) {
        return Promise.resolve(listRecordsResponse([]));
      }
      return Promise.resolve(supporterRecords(KIPCLIP_DID));
    },
  };

  const first = await isUserSupporter(wrapped as typeof session);
  assertEquals(first, false);

  const cached = await isUserSupporter(wrapped as typeof session);
  assertEquals(cached, false, "cache hit");
  assertEquals(callCount, 1);

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
