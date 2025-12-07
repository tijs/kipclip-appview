/**
 * Tests for PLC directory resolution.
 * Uses mock fetcher to avoid network calls.
 */

import "./test-setup.ts";

import { assertEquals } from "@std/assert";
import { resolveDidWithFetcher } from "../lib/plc-resolver.ts";
import { createMockFetcher, createPlcResponse } from "./test-helpers.ts";

Deno.test("resolveDid - resolves valid DID to PDS URL and handle", async () => {
  const mockFetcher = createMockFetcher(
    new Map([
      [
        "plc.directory/did:plc:test123",
        createPlcResponse({
          did: "did:plc:test123",
          pdsUrl: "https://bsky.social",
          handle: "alice.bsky.social",
        }),
      ],
    ]),
  );

  const result = await resolveDidWithFetcher("did:plc:test123", mockFetcher);

  assertEquals(result?.did, "did:plc:test123");
  assertEquals(result?.pdsUrl, "https://bsky.social");
  assertEquals(result?.handle, "alice.bsky.social");
});

Deno.test("resolveDid - returns null for 404 DID", async () => {
  const mockFetcher = createMockFetcher(
    new Map([
      [
        "plc.directory",
        new Response("Not Found", { status: 404 }),
      ],
    ]),
  );

  const result = await resolveDidWithFetcher(
    "did:plc:nonexistent",
    mockFetcher,
  );

  assertEquals(result, null);
});

Deno.test("resolveDid - returns null for non-DID input", async () => {
  const mockFetcher = createMockFetcher(new Map());

  const result = await resolveDidWithFetcher("not-a-did", mockFetcher);

  assertEquals(result, null);
});

Deno.test("resolveDid - returns null for DID without PDS service", async () => {
  const mockFetcher = createMockFetcher(
    new Map([
      [
        "plc.directory/did:plc:nopds",
        new Response(
          JSON.stringify({
            id: "did:plc:nopds",
            alsoKnownAs: ["at://test.handle"],
            service: [], // No services
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
      ],
    ]),
  );

  const result = await resolveDidWithFetcher("did:plc:nopds", mockFetcher);

  assertEquals(result, null);
});

Deno.test("resolveDid - extracts handle from alsoKnownAs", async () => {
  const mockFetcher = createMockFetcher(
    new Map([
      [
        "plc.directory/did:plc:test",
        new Response(
          JSON.stringify({
            id: "did:plc:test",
            alsoKnownAs: ["at://custom.handle.example"],
            service: [
              {
                id: "#atproto_pds",
                type: "AtprotoPersonalDataServer",
                serviceEndpoint: "https://pds.example.com",
              },
            ],
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
      ],
    ]),
  );

  const result = await resolveDidWithFetcher("did:plc:test", mockFetcher);

  assertEquals(result?.handle, "custom.handle.example");
});

Deno.test("resolveDid - uses DID as handle fallback", async () => {
  const mockFetcher = createMockFetcher(
    new Map([
      [
        "plc.directory/did:plc:nohandle",
        new Response(
          JSON.stringify({
            id: "did:plc:nohandle",
            alsoKnownAs: [], // No alsoKnownAs
            service: [
              {
                id: "#atproto_pds",
                type: "AtprotoPersonalDataServer",
                serviceEndpoint: "https://pds.example.com",
              },
            ],
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
      ],
    ]),
  );

  const result = await resolveDidWithFetcher("did:plc:nohandle", mockFetcher);

  assertEquals(result?.handle, "did:plc:nohandle");
});

Deno.test("resolveDid - handles network error gracefully", async () => {
  const mockFetcher = createMockFetcher(
    new Map([
      [
        "plc.directory",
        new Response("Internal Server Error", { status: 500 }),
      ],
    ]),
  );

  const result = await resolveDidWithFetcher("did:plc:error", mockFetcher);

  // Should return null on error (after logging)
  assertEquals(result, null);
});
