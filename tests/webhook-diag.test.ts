/**
 * Tests for lib/webhook-diag.ts — bounded malformed-repoOp diagnostics.
 *
 * The 44 malformed repoOp/parse/handler events observed in the weekly-drift
 * window must produce bounded, classifiable diagnostics: DID suffix, action,
 * relay sequence, error class — never raw payloads, full DIDs, or record
 * bodies.
 */

import "./test-setup.ts";
import { assertEquals, assertStringIncludes } from "@std/assert";

import {
  classifyMalformedEvent,
  diagnoseEvent,
  didSuffix,
  sanitizeLogToken,
  summarizeEvent,
  type WebhookEvtShape,
} from "../lib/webhook-diag.ts";

const FULL_DID = "did:plc:abcdefghijklmnopqrstuvwxyz0123456789";

Deno.test("didSuffix returns the last 12 chars, never the full DID", () => {
  assertEquals(didSuffix(FULL_DID), FULL_DID.slice(-12));
  assertEquals(didSuffix("not-a-did"), null);
  assertEquals(didSuffix(undefined), null);
  assertEquals(didSuffix(12345), null);
  // Short DID-shaped strings must never leak the full identifier: a
  // ≤12-char "DID" has no suffix — the last 12 chars ARE the whole DID.
  assertEquals(didSuffix("did:plc:abc"), null);
  assertEquals(didSuffix("did:plc:abcd"), null);
});

Deno.test("classifyMalformedEvent covers every malformed shape", () => {
  const base = {
    type: "record",
    record: {
      did: FULL_DID,
      collection: "community.lexicon.bookmarks.bookmark",
      rkey: "abc",
      action: "create",
      cid: "bafy",
      record: {},
    },
  };
  assertEquals(classifyMalformedEvent(base), "ok");
  assertEquals(
    classifyMalformedEvent({
      type: "record",
      record: { ...base.record, did: "did:nope" },
    }),
    "invalid-did",
  );
  assertEquals(
    classifyMalformedEvent({
      type: "record",
      record: { ...base.record, did: "" },
    }),
    "invalid-did",
  );
  // A short DID-shaped string has no suffix and must classify as invalid
  // rather than carrying the full identifier into diagnostics.
  assertEquals(
    classifyMalformedEvent({
      type: "record",
      record: { ...base.record, did: "did:plc:xy" },
    }),
    "invalid-did",
  );
  const noDidRecord = { ...base.record };
  delete (noDidRecord as { did?: string }).did;
  assertEquals(
    classifyMalformedEvent({ type: "record", record: noDidRecord }),
    "invalid-did",
  );
  assertEquals(
    classifyMalformedEvent({
      type: "record",
      record: { ...base.record, collection: "" },
    }),
    "missing-collection",
  );
  assertEquals(
    classifyMalformedEvent({
      type: "record",
      record: { ...base.record, rkey: "" },
    }),
    "missing-rkey",
  );
  assertEquals(
    classifyMalformedEvent({
      type: "record",
      record: { ...base.record, action: "explode" },
    }),
    "unknown-action",
  );
  assertEquals(
    classifyMalformedEvent({
      type: "record",
      record: { ...base.record, action: "delete" },
    }),
    "ok",
  );
  assertEquals(
    classifyMalformedEvent({
      type: "record",
      record: { ...base.record, record: undefined, cid: "bafy" },
    }),
    "missing-record",
  );
  assertEquals(classifyMalformedEvent({ type: "record" }), "missing-record");
  assertEquals(
    classifyMalformedEvent({ type: "identity", identity: {} }),
    "unconsumed",
  );
  assertEquals(classifyMalformedEvent({ type: "weird" }), "unconsumed");
});

Deno.test("diagnoseEvent keeps only bounded fields from the fixture event", async () => {
  const fixture = JSON.parse(
    await Deno.readTextFile(
      "tests/fixtures/tap-events/malformed-record.json",
    ),
  ) as WebhookEvtShape;

  const diag = diagnoseEvent(fixture);
  assertEquals(diag.class, "unknown-action");
  assertEquals(diag.seq, 92837);
  assertEquals(diag.type, "record");
  assertEquals(diag.didSuffix, FULL_DID.slice(-12));
  // Never the full DID, never the record body.
  assertStringIncludes(diag.didSuffix ?? "", "0123456789");
  assertEquals(diag.didSuffix === FULL_DID, false);
  // Collection is namespace-summarized.
  assertEquals(diag.collection, "community.lexicon.*");
});

Deno.test("summarizeEvent is one bounded line with no raw payload", async () => {
  const fixture = JSON.parse(
    await Deno.readTextFile(
      "tests/fixtures/tap-events/malformed-record.json",
    ),
  ) as WebhookEvtShape;
  const line = summarizeEvent(fixture);

  assertStringIncludes(line, "seq=92837");
  assertStringIncludes(line, "class=unknown-action");
  assertStringIncludes(line, "community.lexicon.*");
  // The payload's subject URL must never appear.
  assertEquals(line.includes("secret-content"), false);
  assertEquals(line.includes(FULL_DID), false);
  assertEquals(line.length < 160, true);
});

Deno.test("summarizeEvent redacts when the DID is invalid or absent", () => {
  const line = summarizeEvent({
    id: 7,
    type: "record",
    record: {
      did: "definitely-not-a-did",
      collection: "com.kipclip.tag",
      rkey: "x",
      action: "create",
    },
  });
  assertStringIncludes(line, "class=invalid-did");
  assertStringIncludes(line, "did=invalid");
  assertEquals(line.includes("definitely-not-a-did"), false);
  // A short DID-shaped identifier is redacted too — never the full DID.
  const short = summarizeEvent({
    id: 8,
    type: "record",
    record: {
      did: "did:plc:xy",
      collection: "com.kipclip.tag",
      rkey: "x",
      action: "create",
    },
  });
  assertStringIncludes(short, "class=invalid-did");
  assertStringIncludes(short, "did=invalid");
  assertEquals(short.includes("did:plc:xy"), false);
});

Deno.test("sanitizeLogToken strips control chars/newlines and bounds length", () => {
  // Journal injection: a bucket with a newline must become a single token.
  const evil = "evil\nline2\r\nESC\u001b[31m";
  const safe = sanitizeLogToken(evil);
  assertEquals(safe.includes("\n"), false);
  assertEquals(safe.includes("\r"), false);
  assertEquals(safe.includes("\u001b"), false);
  assertStringIncludes(safe, "evil");

  // Unbounded creator-controlled text is truncated.
  const long = "c".repeat(5000);
  assertEquals(sanitizeLogToken(long).length <= 64, true);

  // Default-length overview: a normal collection is unchanged.
  assertEquals(
    sanitizeLogToken("community.lexicon.bookmarks.bookmark"),
    "community.lexicon.bookmarks.bookmark",
  );
  // Bounded key: two distinct-but-identically-truncated buckets dedupe.
  assertEquals(sanitizeLogToken(long), sanitizeLogToken(long + "zzzz"));
  // Empty / whitespace-only input collapses to a non-blank token so a
  // dedupe-set key can never be empty.
  assertEquals(sanitizeLogToken(""), "?");
  assertEquals(sanitizeLogToken("   "), "?");
  assertEquals(sanitizeLogToken("\n\n\n"), "?");
});

Deno.test("hostile creator-controlled collection stays bounded in diagnoseEvent/summarizeEvent", () => {
  // A dot-less collection bypassed the old namespace-redaction (split(".")[0]
  // was the whole raw string) and carried newlines + unbounded length into
  // the journal via summarizeEvent.
  const hostile = "evil\ninjected\r\nline" + "y".repeat(500);
  const evt = {
    id: 77,
    type: "record",
    record: {
      did: FULL_DID,
      collection: hostile,
      rkey: "r",
      action: "create",
      cid: "bafy",
      record: {},
    },
  };
  const diag = diagnoseEvent(evt);
  assertEquals(diag.collection?.includes("\n"), false);
  assertEquals(diag.collection?.includes("\r"), false);
  assertEquals((diag.collection ?? "").length <= 66, true); // 2*32 + "."
  const line = summarizeEvent(evt);
  assertEquals(line.includes("\n"), false, "summary must stay one line");
  assertEquals(line.includes("\r"), false);
  assertEquals(
    line.includes(hostile),
    false,
    "raw collection must never appear",
  );
  assertEquals(
    line.length < 200,
    true,
    `summary must stay bounded, got ${line.length}`,
  );
});
