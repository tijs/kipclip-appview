/**
 * Tests for lib/tap-only-cleanup.ts — approval-gated TAP-only enrollment
 * cleanup classification and selection.
 */

import "./test-setup.ts";
import { assertEquals } from "@std/assert";

import {
  classifyTapOnlyDid,
  decideTapOnlyRemoval,
  type TapOnlyEvidence,
} from "../lib/tap-only-cleanup.ts";

const DID = "did:plc:taponly1234567890";

function evidence(over: Partial<TapOnlyEvidence> = {}): TapOnlyEvidence {
  return {
    plc: { did: DID, pdsUrl: "https://pds.example.test" },
    pds: "missing",
    knownMissing: false,
    mirror: 0,
    seen: true,
    ...over,
  };
}

Deno.test("classifyTapOnlyDid: healthy PDS with repo absent -> reponotfound (candidate)", () => {
  const row = classifyTapOnlyDid(DID, evidence({ pds: "missing" }));
  assertEquals(row.category, "reponotfound");
});

Deno.test("classifyTapOnlyDid: unavailable PDS -> unavailable (retention, never deletion)", () => {
  const row = classifyTapOnlyDid(
    DID,
    evidence({ pds: "unavailable", knownMissing: true }),
  );
  assertEquals(row.category, "unavailable");
});

Deno.test("classifyTapOnlyDid: healthy live repo -> healthy (re-enroll, never remove)", () => {
  const row = classifyTapOnlyDid(DID, evidence({ pds: "healthy" }));
  assertEquals(row.category, "healthy");
});

Deno.test("classifyTapOnlyDid: PLC resolution failure -> unresolved", () => {
  const row = classifyTapOnlyDid(
    DID,
    evidence({ plc: null, pds: "not-probed" }),
  );
  assertEquals(row.category, "unresolved");
});

Deno.test("classifyTapOnlyDid: known-missing evidence when PDS not probed -> known-missing (suppressed)", () => {
  const row = classifyTapOnlyDid(
    DID,
    evidence({ pds: "not-probed", knownMissing: true }),
  );
  assertEquals(row.category, "known-missing");
});

Deno.test("decision: reponotfound needs the full-DID confirmation token; dry-run never removes", () => {
  const row = classifyTapOnlyDid(DID, evidence({ pds: "missing" }));
  assertEquals(
    decideTapOnlyRemoval(row, null).decision,
    "suppressed",
  );
  assertEquals(
    decideTapOnlyRemoval(row, "did:plc:different").decision,
    "suppressed",
  );
  assertEquals(decideTapOnlyRemoval(row, DID).decision, "remove");
});

Deno.test("decision: unavailable / healthy / unresolved are blocked even with confirmation", () => {
  const blocked = [
    classifyTapOnlyDid(DID, evidence({ pds: "unavailable" })),
    classifyTapOnlyDid(DID, evidence({ pds: "healthy" })),
    classifyTapOnlyDid(DID, evidence({ plc: null, pds: "not-probed" })),
  ];
  for (const row of blocked) {
    assertEquals(
      decideTapOnlyRemoval(row, DID).decision,
      "blocked",
      `${row.category} must be blocked even with confirmation`,
    );
  }
});

Deno.test("decision: known-missing is suppressed from the default list but removable with confirmation", () => {
  const row = classifyTapOnlyDid(
    DID,
    evidence({ pds: "not-probed", knownMissing: true }),
  );
  assertEquals(decideTapOnlyRemoval(row, null).decision, "suppressed");
  assertEquals(decideTapOnlyRemoval(row, DID).decision, "remove");
});

Deno.test("selection: a repo that returned (healthy) leaves the removal set — re-enroll instead", () => {
  // The DID used to be missing; the operator path re-probes and finds the
  // repo live again. It must NOT be a removal candidate.
  const row = classifyTapOnlyDid(DID, evidence({ pds: "healthy" }));
  assertEquals(row.category, "healthy");
  assertEquals(decideTapOnlyRemoval(row, DID).decision, "blocked");
});
