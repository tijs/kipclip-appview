/**
 * Bounded TAP webhook event diagnostics.
 *
 * The weekly-drift investigation surfaced ~44 malformed `repoOp`/parse/
 * handler events in TAP's journal. Whatever the root cause (relay/
 * TAP incompatibility or consumer-side), the first safe step is bounded
 * diagnostics: classify the malformed shape and summarize it with
 * DID-suffix / action / relay sequence / error class only — NEVER raw
 * payloads, credentials, record bodies, or full DIDs.
 *
 * The consumer (worker/webhook.ts) logs these summaries instead of
 * serializing whole events into Sentry extras or log lines.
 */

export interface WebhookEvtShape {
  id?: number;
  type?: string;
  record?: {
    did?: string;
    collection?: string;
    rkey?: string;
    action?: string;
    record?: unknown;
    cid?: string;
  };
  identity?: unknown;
}

export type MalformedClass =
  | "ok"
  | "unconsumed"
  | "invalid-did"
  | "missing-collection"
  | "missing-rkey"
  | "missing-record"
  | "unknown-action";

export interface EventDiag {
  /** Relay sequence number (TAP event id). */
  seq?: number;
  type?: string;
  /** Last 12 chars of the DID — never the full identifier. */
  didSuffix?: string;
  action?: string;
  collection?: string;
  class: MalformedClass;
}

/** Last 12 chars of a DID, or null when unset/not a DID shape. */
export function didSuffix(did: unknown): string | null {
  if (typeof did !== "string" || !did.startsWith("did:")) return null;
  // A real DID has at least `did:<method>:<identifier>`.
  const parts = did.split(":");
  if (parts.length < 3 || parts[2].length === 0) return null;
  return did.length > 12 ? did.slice(-12) : did;
}

/**
 * Classify a webhook event. Valid-but-unconsumed shapes (identity events,
 * unknown types) are `unconsumed`; `ok` means the record handler will
 * apply it. Malformed shapes get a stable class for reporting.
 */
export function classifyMalformedEvent(evt: WebhookEvtShape): MalformedClass {
  if (evt.type === "record") {
    const r = evt.record;
    if (!r) return "missing-record";
    if (didSuffix(r.did) === null) {
      return "invalid-did";
    }
    if (typeof r.collection !== "string" || r.collection.length === 0) {
      return "missing-collection";
    }
    if (typeof r.rkey !== "string" || r.rkey.length === 0) {
      return "missing-rkey";
    }
    if (r.action === "delete") return "ok";
    if (r.action !== "create" && r.action !== "update") {
      return "unknown-action";
    }
    if (!r.cid || !r.record) return "missing-record";
    return "ok";
  }
  if (evt.type === "identity") return "unconsumed";
  return "unconsumed";
}

/** One-line bounded summary for logs / Sentry extras. */
export function summarizeEvent(evt: WebhookEvtShape): string {
  const d = diagnoseEvent(evt);
  const parts = [`type=${d.type ?? "?"}`];
  if (d.seq !== undefined) parts.push(`seq=${d.seq}`);
  if (d.didSuffix) {
    parts.push(
      d.didSuffix === "invalid" ? "did=invalid" : `did=…${d.didSuffix}`,
    );
  }
  if (d.action) parts.push(`action=${d.action}`);
  if (d.collection) parts.push(`collection=${d.collection}`);
  parts.push(`class=${d.class}`);
  return parts.join(" ");
}

/** Classify + collect the bounded fields (pure, testable). */
export function diagnoseEvent(evt: WebhookEvtShape): EventDiag {
  const diag: EventDiag = { class: classifyMalformedEvent(evt) };
  if (typeof evt.id === "number") diag.seq = evt.id;
  if (typeof evt.type === "string") diag.type = evt.type;
  const r = evt.record;
  if (evt.type === "record" && r) {
    const suffix = didSuffix(r.did);
    if (suffix) diag.didSuffix = suffix;
    else if (r.did !== undefined) diag.didSuffix = "invalid";
    if (typeof r.action === "string") diag.action = r.action;
    // Collection names are namespace identifiers (no user data); safe to
    // include in bounded diagnostics. Redact everything past the final token.
    if (typeof r.collection === "string") {
      const parts = r.collection.split(".");
      diag.collection = parts.slice(0, 2).join(".") +
        (parts.length > 2 ? ".*" : "");
    }
  }
  return diag;
}
